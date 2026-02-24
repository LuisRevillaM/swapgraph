import {
  mapErrorEnvelope,
  mapInventoryAwakeningProjection,
  mapIntentDto,
  mapIntentListResponse,
  mapMatchingRunDto,
  mapProposalDto,
  mapProposalListResponse,
  mapReceiptDto,
  mapTimelineDto
} from '../domain/mappers.mjs';
import { createIdempotencyKey, isMutationMethod } from './idempotency.mjs';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonOrNull(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function buildActorHeaders(actorContext = {}, requestScopes = []) {
  const actorType = actorContext.actorType ?? null;
  const actorId = actorContext.actorId ?? null;
  const scopes = Array.isArray(requestScopes) && requestScopes.length > 0
    ? requestScopes
    : (Array.isArray(actorContext.scopes) ? actorContext.scopes : []);

  const headers = {};
  if (actorType) headers['x-actor-type'] = actorType;
  if (actorId) headers['x-actor-id'] = actorId;
  if (scopes.length > 0) headers['x-auth-scopes'] = scopes.join(' ');
  return headers;
}

function actorScopeSet(actorContext = {}) {
  const scopes = Array.isArray(actorContext?.scopes) ? actorContext.scopes : [];
  return new Set(scopes.map(scope => String(scope)));
}

export class ApiClientError extends Error {
  constructor({ operation, status, code, message, details, responseBody }) {
    super(message);
    this.name = 'ApiClientError';
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.details = details ?? {};
    this.responseBody = responseBody ?? null;
  }
}

export class MarketplaceApiClient {
  constructor({
    baseUrl = '/api',
    fetchImpl = fetch,
    getActorContext = () => ({ actorType: 'user', actorId: 'web_client_user', scopes: ['swap_intents:read'] }),
    getCsrfToken = () => null,
    onRetry = null,
    defaultRetries = 2,
    baseRetryDelayMs = 120,
    maxRetryDelayMs = 900
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.getActorContext = getActorContext;
    this.getCsrfToken = typeof getCsrfToken === 'function' ? getCsrfToken : (() => null);
    this.onRetry = typeof onRetry === 'function' ? onRetry : null;
    this.defaultRetries = defaultRetries;
    this.baseRetryDelayMs = baseRetryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
  }

  async request({
    operation,
    method = 'GET',
    path,
    body,
    scopes = [],
    idempotencyKey = null,
    retries = this.defaultRetries
  }) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const actorContext = this.getActorContext() ?? {};
    const actorScopes = actorScopeSet(actorContext);
    const requiredScopes = Array.isArray(scopes) ? scopes.map(scope => String(scope)) : [];
    const missingScopes = requiredScopes.filter(scope => !actorScopes.has(scope));
    if (missingScopes.length > 0) {
      throw new ApiClientError({
        operation,
        status: 403,
        code: 'AUTH_SCOPE_MISSING',
        message: `missing required scopes: ${missingScopes.join(', ')}`,
        details: {
          missing_scopes: missingScopes,
          actor_scopes: [...actorScopes]
        },
        responseBody: null
      });
    }

    const headers = {
      accept: 'application/json',
      ...buildActorHeaders(actorContext, scopes)
    };

    if (body !== undefined) headers['content-type'] = 'application/json';
    if (isMutationMethod(normalizedMethod) && idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (isMutationMethod(normalizedMethod)) {
      const csrfToken = this.getCsrfToken();
      if (csrfToken) headers['x-csrf-token'] = String(csrfToken);
    }

    const targetUrl = `${this.baseUrl}${path}`;

    let attempt = 0;
    let lastError = null;

    while (attempt <= retries) {
      if (attempt > 0) {
        const delayMs = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** (attempt - 1)));
        if (this.onRetry) this.onRetry({ operation, attempt, delayMs });
        await sleep(delayMs);
      }

      try {
        const response = await this.fetchImpl(targetUrl, {
          method: normalizedMethod,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error'
        });

        const rawText = await response.text();
        const parsedBody = jsonOrNull(rawText);
        const correlationId = response.headers.get('x-correlation-id');

        if (!response.ok) {
          const mapped = mapErrorEnvelope(parsedBody, response.status);
          const error = new ApiClientError({
            operation,
            status: mapped.status,
            code: mapped.code,
            message: mapped.message,
            details: mapped.details,
            responseBody: parsedBody
          });
          if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
            lastError = error;
            attempt += 1;
            continue;
          }
          throw error;
        }

        return {
          status: response.status,
          correlationId,
          data: parsedBody,
          retryCount: attempt
        };
      } catch (error) {
        const shouldRetry = !(error instanceof ApiClientError)
          || (error.status && RETRYABLE_STATUS.has(error.status));

        if (shouldRetry && attempt < retries) {
          lastError = error;
          attempt += 1;
          continue;
        }

        if (error instanceof ApiClientError) throw error;

        throw new ApiClientError({
          operation,
          status: 0,
          code: 'NETWORK_ERROR',
          message: String(error?.message ?? error),
          details: {},
          responseBody: null
        });
      }
    }

    throw lastError;
  }

  async getHealth() {
    const res = await this.request({
      operation: 'health.read',
      method: 'GET',
      path: '/healthz',
      scopes: ['swap_intents:read']
    });
    return { ...res, health: res.data };
  }

  async listIntents() {
    const res = await this.request({
      operation: 'intents.list',
      method: 'GET',
      path: '/swap-intents',
      scopes: ['swap_intents:read']
    });
    return { ...res, intents: mapIntentListResponse(res.data) };
  }

  async getInventoryAwakeningProjection() {
    const res = await this.request({
      operation: 'projection.inventory_awakening',
      method: 'GET',
      path: '/product-projections/inventory-awakening',
      scopes: ['settlement:read']
    });
    return {
      ...res,
      projection: mapInventoryAwakeningProjection(res.data)
    };
  }

  async createIntent({ intent, idempotencyKey = createIdempotencyKey('intent_create') }) {
    const res = await this.request({
      operation: 'intents.create',
      method: 'POST',
      path: '/swap-intents',
      scopes: ['swap_intents:write'],
      idempotencyKey,
      body: { intent }
    });

    return {
      ...res,
      idempotencyKey,
      intent: mapIntentDto(res.data?.intent)
    };
  }

  async updateIntent({ id, intent, idempotencyKey = createIdempotencyKey('intent_update') }) {
    const safeId = encodeURIComponent(String(id));
    const res = await this.request({
      operation: 'intents.update',
      method: 'PATCH',
      path: `/swap-intents/${safeId}`,
      scopes: ['swap_intents:write'],
      idempotencyKey,
      body: { intent }
    });

    return {
      ...res,
      idempotencyKey,
      intent: mapIntentDto(res.data?.intent)
    };
  }

  async cancelIntent({ id, idempotencyKey = createIdempotencyKey('intent_cancel') }) {
    const safeId = encodeURIComponent(String(id));
    const res = await this.request({
      operation: 'intents.cancel',
      method: 'POST',
      path: `/swap-intents/${safeId}/cancel`,
      scopes: ['swap_intents:write'],
      idempotencyKey,
      body: { id: String(id) }
    });

    return {
      ...res,
      idempotencyKey,
      cancel: {
        id: String(res.data?.id ?? id),
        status: String(res.data?.status ?? 'cancelled')
      }
    };
  }

  async listProposals() {
    const res = await this.request({
      operation: 'proposals.list',
      method: 'GET',
      path: '/cycle-proposals',
      scopes: ['cycle_proposals:read']
    });
    return { ...res, proposals: mapProposalListResponse(res.data) };
  }

  async runMatching({ replaceExisting = true, maxProposals = 20, idempotencyKey = createIdempotencyKey('matching_run') }) {
    const res = await this.request({
      operation: 'matching.run',
      method: 'POST',
      path: '/marketplace/matching/runs',
      scopes: ['settlement:write'],
      idempotencyKey,
      body: {
        replace_existing: replaceExisting,
        max_proposals: maxProposals
      }
    });

    return {
      ...res,
      idempotencyKey,
      run: mapMatchingRunDto(res.data?.run)
    };
  }

  async getMatchingRun(runId) {
    const res = await this.request({
      operation: 'matching.run.get',
      method: 'GET',
      path: `/marketplace/matching/runs/${encodeURIComponent(runId)}`,
      scopes: ['settlement:read']
    });
    return {
      ...res,
      run: mapMatchingRunDto(res.data?.run)
    };
  }

  async getTimeline(cycleId) {
    const res = await this.request({
      operation: 'timeline.get',
      method: 'GET',
      path: `/settlement/${encodeURIComponent(cycleId)}/status`,
      scopes: ['settlement:read']
    });
    return {
      ...res,
      timeline: mapTimelineDto(res.data?.timeline)
    };
  }

  async getReceipt(cycleId) {
    const res = await this.request({
      operation: 'receipt.get',
      method: 'GET',
      path: `/receipts/${encodeURIComponent(cycleId)}`,
      scopes: ['receipts:read']
    });

    return {
      ...res,
      receipt: mapReceiptDto(res.data?.receipt)
    };
  }

  async acceptProposal({ proposalId, idempotencyKey = createIdempotencyKey('proposal_accept') }) {
    const res = await this.request({
      operation: 'proposal.accept',
      method: 'POST',
      path: `/cycle-proposals/${encodeURIComponent(proposalId)}/accept`,
      scopes: ['commits:write'],
      idempotencyKey,
      body: {
        proposal_id: proposalId
      }
    });

    return {
      ...res,
      idempotencyKey,
      commit: res.data?.commit ?? null
    };
  }

  async declineProposal({ proposalId, idempotencyKey = createIdempotencyKey('proposal_decline') }) {
    const res = await this.request({
      operation: 'proposal.decline',
      method: 'POST',
      path: `/cycle-proposals/${encodeURIComponent(proposalId)}/decline`,
      scopes: ['commits:write'],
      idempotencyKey,
      body: {
        proposal_id: proposalId
      }
    });

    return {
      ...res,
      idempotencyKey,
      commit: res.data?.commit ?? null
    };
  }

  async startSettlement({ cycleId, depositDeadlineAt, idempotencyKey = createIdempotencyKey('settlement_start') }) {
    const res = await this.request({
      operation: 'settlement.start',
      method: 'POST',
      path: `/settlement/${encodeURIComponent(cycleId)}/start`,
      scopes: ['settlement:write'],
      idempotencyKey,
      body: {
        deposit_deadline_at: depositDeadlineAt
      }
    });

    return {
      ...res,
      idempotencyKey,
      timeline: mapTimelineDto(res.data?.timeline)
    };
  }

  async confirmDeposit({
    cycleId,
    depositRef = createIdempotencyKey('deposit'),
    idempotencyKey = createIdempotencyKey('settlement_deposit_confirmed')
  }) {
    const res = await this.request({
      operation: 'settlement.deposit_confirmed',
      method: 'POST',
      path: `/settlement/${encodeURIComponent(cycleId)}/deposit-confirmed`,
      scopes: ['settlement:write'],
      idempotencyKey,
      body: {
        deposit_ref: depositRef
      }
    });

    return {
      ...res,
      idempotencyKey,
      timeline: mapTimelineDto(res.data?.timeline)
    };
  }

  async beginExecution({ cycleId, idempotencyKey = createIdempotencyKey('settlement_begin_execution') }) {
    const res = await this.request({
      operation: 'settlement.begin_execution',
      method: 'POST',
      path: `/settlement/${encodeURIComponent(cycleId)}/begin-execution`,
      scopes: ['settlement:write'],
      idempotencyKey,
      body: {}
    });

    return {
      ...res,
      idempotencyKey,
      timeline: mapTimelineDto(res.data?.timeline)
    };
  }

  async completeSettlement({ cycleId, idempotencyKey = createIdempotencyKey('settlement_complete') }) {
    const res = await this.request({
      operation: 'settlement.complete',
      method: 'POST',
      path: `/settlement/${encodeURIComponent(cycleId)}/complete`,
      scopes: ['settlement:write'],
      idempotencyKey,
      body: {}
    });

    return {
      ...res,
      idempotencyKey,
      timeline: mapTimelineDto(res.data?.timeline),
      receipt: res.data?.receipt ? mapReceiptDto(res.data?.receipt) : null
    };
  }
}
