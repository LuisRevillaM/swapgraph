import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { effectiveActorForDelegation } from '../core/tradingPolicyBoundaries.mjs';
import { signReceipt } from '../crypto/receiptSigning.mjs';

const DEAL_STATUS = new Set([
  'draft',
  'pending_accept',
  'ready_for_settlement',
  'settlement_in_progress',
  'completed',
  'failed',
  'cancelled'
]);
const SETTLEMENT_MODES = new Set(['internal_credit', 'external_payment_proof', 'cycle_bridge']);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseLimit(value, fallback = 25) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 100);
}

function sortByUpdatedDescThenId(rows, idField) {
  rows.sort((a, b) => {
    const at = parseIsoMs(a.updated_at) ?? 0;
    const bt = parseIsoMs(b.updated_at) ?? 0;
    if (bt !== at) return bt - at;
    return String(a[idField] ?? '').localeCompare(String(b[idField] ?? ''));
  });
}

function encodeCursor(parts) {
  return parts.join('|');
}

function decodeCursor(raw, expectedParts) {
  const value = normalizeOptionalString(raw);
  if (!value) return null;
  const parts = value.split('|');
  if (parts.length !== expectedParts) return undefined;
  if (parts.some(part => !part)) return undefined;
  return parts;
}

function buildPaginationSlice({ rows, limit, cursorAfter, keyFn, cursorParts }) {
  let start = 0;
  if (cursorAfter) {
    const decoded = decodeCursor(cursorAfter, cursorParts);
    if (decoded === undefined) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid cursor format',
        details: { reason_code: 'market_feed_query_invalid', cursor_after: cursorAfter }
      };
    }
    if (decoded) {
      const idx = rows.findIndex(row => {
        const key = keyFn(row);
        return key.length === decoded.length && key.every((v, i) => String(v) === String(decoded[i]));
      });
      if (idx < 0) {
        return {
          ok: false,
          code: 'CONSTRAINT_VIOLATION',
          message: 'cursor not found',
          details: { reason_code: 'market_cursor_not_found', cursor_after: cursorAfter }
        };
      }
      start = idx + 1;
    }
  }

  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(keyFn(page[page.length - 1])) : null;
  return {
    ok: true,
    value: {
      page,
      total: rows.length,
      nextCursor
    }
  };
}

function normalizeRecordedAt(request, auth) {
  return normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
}

function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: {
      code,
      message,
      details
    }
  };
}

function actorEquals(a, b) {
  return (a?.type ?? null) === (b?.type ?? null) && (a?.id ?? null) === (b?.id ?? null);
}

function includesActor(participants, actor) {
  return Array.isArray(participants) && participants.some(p => actorEquals(p, actor));
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.market_deals ||= {};
  store.state.market_deal_counter ||= 0;
  store.state.market_payment_proofs ||= {};
  store.state.market_payment_proof_counter ||= 0;
  store.state.market_threads ||= {};
  store.state.market_thread_counter ||= 0;
  store.state.market_messages ||= {};
  store.state.market_message_counter ||= 0;
  store.state.receipts ||= {};
  store.state.market_actor_quotas ||= {};
}

function nextDealId(store) {
  store.state.market_deal_counter = Number(store.state.market_deal_counter ?? 0) + 1;
  return `deal_${String(store.state.market_deal_counter).padStart(6, '0')}`;
}

function nextPaymentProofId(store) {
  store.state.market_payment_proof_counter = Number(store.state.market_payment_proof_counter ?? 0) + 1;
  return `proof_${String(store.state.market_payment_proof_counter).padStart(6, '0')}`;
}

function nextThreadId(store) {
  store.state.market_thread_counter = Number(store.state.market_thread_counter ?? 0) + 1;
  return `thread_${String(store.state.market_thread_counter).padStart(6, '0')}`;
}

function nextMessageId(store) {
  store.state.market_message_counter = Number(store.state.market_message_counter ?? 0) + 1;
  return `message_${String(store.state.market_message_counter).padStart(6, '0')}`;
}

function normalizeDealView(record) {
  return {
    deal_id: record.deal_id,
    workspace_id: record.workspace_id,
    origin_edge_id: record.origin_edge_id,
    participants: clone(record.participants),
    settlement_mode: record.settlement_mode ?? null,
    status: record.status,
    terms: record.terms ? clone(record.terms) : null,
    settlement_ref: record.settlement_ref ?? null,
    receipt_ref: record.receipt_ref ?? null,
    payment_proof_id: record.payment_proof_id ?? null,
    thread_id: record.thread_id ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function normalizePaymentProofView(record) {
  return {
    proof_id: record.proof_id,
    deal_id: record.deal_id,
    payment_rail: record.payment_rail,
    proof_fingerprint: record.proof_fingerprint,
    external_reference: record.external_reference ?? null,
    payer_actor: record.payer_actor ? clone(record.payer_actor) : null,
    payee_actor: record.payee_actor ? clone(record.payee_actor) : null,
    payer_attested_at: record.payer_attested_at ?? null,
    payee_attested_at: record.payee_attested_at ?? null,
    nonce: record.nonce,
    expires_at: record.expires_at,
    consumed_at: record.consumed_at ?? null,
    created_at: record.created_at
  };
}

function ttlSeconds() {
  const value = Number.parseInt(String(process.env.MARKET_PAYMENT_PROOF_TTL_SECS ?? '86400'), 10);
  if (!Number.isFinite(value) || value < 60) return 86400;
  return value;
}

function plusSeconds(iso, seconds) {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  return new Date(ms + (seconds * 1000)).toISOString();
}

function normalizePositiveAmount(terms) {
  const candidates = [
    terms?.credit_amount,
    terms?.amount,
    terms?.amount_usd,
    terms?.price?.amount,
    terms?.price?.amount_usd
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function parseRateLimitEnv(name, fallback) {
  const raw = Number.parseInt(String(process.env[name] ?? fallback), 10);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return raw;
}

function startOfHourIso(iso) {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  const date = new Date(ms);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function ensureRateWindow(record, actionKey, windowStartedAt) {
  record.rate_windows ||= {};
  if (!record.rate_windows[actionKey] || record.rate_windows[actionKey].window_started_at !== windowStartedAt) {
    record.rate_windows[actionKey] = {
      window_started_at: windowStartedAt,
      count: 0
    };
  }
  return record.rate_windows[actionKey];
}

function applyRateLimit({ quotaRecord, actionKey, limit, recordedAt }) {
  const windowStartedAt = startOfHourIso(recordedAt);
  if (!windowStartedAt) return { ok: false, count: 0, limit };
  const bucket = ensureRateWindow(quotaRecord, actionKey, windowStartedAt);
  if (bucket.count >= limit) {
    return {
      ok: false,
      count: bucket.count,
      limit,
      window_started_at: bucket.window_started_at
    };
  }
  bucket.count += 1;
  return {
    ok: true,
    count: bucket.count,
    limit,
    window_started_at: bucket.window_started_at
  };
}

function listingIsPublicVisible(listing) {
  return !!listing && listing.status !== 'suspended';
}

function edgeIsPublicVisible(store, edge) {
  if (!edge) return false;
  const source = store.state.market_listings?.[edge.source_ref?.id] ?? null;
  const target = store.state.market_listings?.[edge.target_ref?.id] ?? null;
  return listingIsPublicVisible(source) && listingIsPublicVisible(target);
}

function dealIsPublicVisible(store, deal) {
  if (!deal) return false;
  const edge = store.state.market_edges?.[deal.origin_edge_id] ?? null;
  return edgeIsPublicVisible(store, edge);
}

function normalizeDealListQuery(query) {
  const allowed = new Set(['workspace_id', 'status', 'settlement_mode', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const status = normalizeOptionalString(query?.status)?.toLowerCase() ?? null;
  const settlementMode = normalizeOptionalString(query?.settlement_mode)?.toLowerCase() ?? null;
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (status && !DEAL_STATUS.has(status)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid deal status filter',
      details: { reason_code: 'market_deal_invalid', status }
    };
  }
  if (settlementMode && !SETTLEMENT_MODES.has(settlementMode)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid settlement mode filter',
      details: { reason_code: 'market_deal_invalid', settlement_mode: settlementMode }
    };
  }
  if (limit === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid limit',
      details: { reason_code: 'market_feed_query_invalid', limit: query?.limit }
    };
  }
  return {
    ok: true,
    value: {
      workspace_id: workspaceId,
      status,
      settlement_mode: settlementMode,
      limit,
      cursor_after: cursorAfter
    }
  };
}

export class MarketDealService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _authorize({ actor, auth, operationId, correlationId: corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
      };
    }
    return { ok: true };
  }

  _subjectActor({ actor, auth }) {
    return effectiveActorForDelegation({ actor, auth }) ?? actor;
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return {
          replayed: true,
          result: clone(existing.result)
        };
      }

      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', {
            operation_id: operationId,
            idempotency_key: idempotencyKey
          })
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = {
      payload_hash: requestHash,
      result: clone(result)
    };
    return { replayed: false, result };
  }

  _loadEdgeOrError({ edgeId, correlationId: corr }) {
    const record = this.store.state.market_edges?.[edgeId] ?? null;
    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'edge not found', {
          reason_code: 'market_edge_not_found',
          edge_id: edgeId
        })
      };
    }
    return { ok: true, record };
  }

  _loadDealOrError({ dealId, correlationId: corr }) {
    const record = this.store.state.market_deals?.[dealId] ?? null;
    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'deal not found', {
          reason_code: 'market_deal_not_found',
          deal_id: dealId
        })
      };
    }
    return { ok: true, record };
  }

  _loadListing(listingId) {
    return this.store.state.market_listings?.[listingId] ?? null;
  }

  _activeDealForEdge(edgeId) {
    return Object.values(this.store.state.market_deals ?? {}).find(record => (
      record.origin_edge_id === edgeId
      && record.status !== 'completed'
      && record.status !== 'failed'
      && record.status !== 'cancelled'
    )) ?? null;
  }

  _findBlockingEdge(edge) {
    return Object.values(this.store.state.market_edges ?? {}).find(candidate => (
      candidate.edge_type === 'block'
      && (
        (candidate.source_ref?.id === edge.source_ref?.id && candidate.target_ref?.id === edge.target_ref?.id)
        || (candidate.source_ref?.id === edge.target_ref?.id && candidate.target_ref?.id === edge.source_ref?.id)
      )
      && candidate.status !== 'withdrawn'
      && candidate.status !== 'declined'
      && candidate.status !== 'expired'
    )) ?? null;
  }

  _ensureParticipant({ deal, actor, correlationId: corr }) {
    if (includesActor(deal?.participants, actor)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'deal participant required', {
        reason_code: 'market_deal_forbidden',
        deal_id: deal?.deal_id ?? null,
        actor
      })
    };
  }

  _ensureActorQuota(actor) {
    const key = `${actor?.type}:${actor?.id}`;
    this.store.state.market_actor_quotas[key] ||= { credit_balance: 100, rate_windows: {}, deals_created: 0 };
    this.store.state.market_actor_quotas[key].rate_windows ||= {};
    return this.store.state.market_actor_quotas[key];
  }

  _ensureThread({ workspaceId, participants, anchorRef, recordedAt, threadId }) {
    if (threadId) {
      const existing = this.store.state.market_threads?.[threadId] ?? null;
      if (existing) return existing;
    }

    const anchored = Object.values(this.store.state.market_threads ?? {}).find(thread => (
      thread.workspace_id === workspaceId
      && thread.anchor_ref?.kind === anchorRef.kind
      && thread.anchor_ref?.id === anchorRef.id
    ));
    if (anchored) return anchored;

    const createdThreadId = threadId ?? nextThreadId(this.store);
    const record = {
      thread_id: createdThreadId,
      workspace_id: workspaceId,
      participants: clone(participants),
      status: 'active',
      anchor_ref: clone(anchorRef),
      created_at: recordedAt,
      updated_at: recordedAt
    };
    this.store.state.market_threads[createdThreadId] = record;
    return record;
  }

  _appendSystemMessage({ threadId, payload, recordedAt }) {
    if (!threadId) return;
    const thread = this.store.state.market_threads?.[threadId] ?? null;
    if (!thread) return;
    const messageId = nextMessageId(this.store);
    this.store.state.market_messages[messageId] = {
      message_id: messageId,
      thread_id: threadId,
      sender_actor: { type: 'partner', id: 'swapgraph-market' },
      message_type: 'system',
      payload: clone(payload),
      created_at: recordedAt
    };
    thread.updated_at = recordedAt;
  }

  _mintReceipt({ deal, recordedAt, finalState = 'completed' }) {
    const cycleId = deal.settlement_ref ?? deal.deal_id;
    const existing = this.store.state.receipts?.[cycleId] ?? null;
    if (existing) return existing;

    const unsigned = {
      id: `receipt_${deal.deal_id}`,
      cycle_id: cycleId,
      final_state: finalState,
      intent_ids: [],
      asset_ids: [],
      created_at: recordedAt,
      transparency: {
        market_deal_id: deal.deal_id,
        settlement_mode: deal.settlement_mode
      }
    };
    const signed = { ...unsigned, signature: signReceipt(unsigned) };
    this.store.state.receipts[cycleId] = signed;
    return signed;
  }

  createFromEdge({ actor, auth, edgeId, idempotencyKey, request }) {
    const op = 'marketDeals.createFromEdge';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const subjectActor = this._subjectActor({ actor, auth });
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid deal timestamp', {
              reason_code: 'market_deal_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const edgeLoad = this._loadEdgeOrError({ edgeId, correlationId: corr });
        if (!edgeLoad.ok) return { ok: false, body: edgeLoad.body };
        const edge = edgeLoad.record;

        const sourceListing = this._loadListing(edge.source_ref?.id);
        const targetListing = this._loadListing(edge.target_ref?.id);
        if (!sourceListing || !targetListing) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'deal edge listing not found', {
              reason_code: 'market_deal_invalid',
              edge_id: edgeId
            })
          };
        }

        if (!actorEquals(sourceListing.owner_actor, subjectActor) && !actorEquals(targetListing.owner_actor, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'deal participant required', {
              reason_code: 'market_deal_forbidden',
              edge_id: edgeId,
              actor: subjectActor
            })
          };
        }

        const actorQuota = this._ensureActorQuota(subjectActor);
        const dealRateLimit = applyRateLimit({
          quotaRecord: actorQuota,
          actionKey: 'deal_create',
          limit: parseRateLimitEnv('MARKET_DEAL_RATE_LIMIT_PER_HOUR', 60),
          recordedAt
        });
        actorQuota.updated_at = recordedAt;
        if (!dealRateLimit.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'deal rate limit exceeded', {
              reason_code: 'market_deal_rate_limited',
              limit: dealRateLimit.limit,
              window_started_at: dealRateLimit.window_started_at
            })
          };
        }

        if (edge.status !== 'accepted' || edge.edge_type === 'block') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'edge is not eligible for deal creation', {
              reason_code: 'market_deal_invalid',
              edge_id: edgeId,
              edge_status: edge.status,
              edge_type: edge.edge_type
            })
          };
        }

        if ((edge.expires_at && parseIsoMs(edge.expires_at) !== null && parseIsoMs(edge.expires_at) < parseIsoMs(recordedAt))
          || (sourceListing.expires_at && parseIsoMs(sourceListing.expires_at) !== null && parseIsoMs(sourceListing.expires_at) < parseIsoMs(recordedAt))
          || (targetListing.expires_at && parseIsoMs(targetListing.expires_at) !== null && parseIsoMs(targetListing.expires_at) < parseIsoMs(recordedAt))) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'expired market object cannot form a deal', {
              reason_code: 'market_deal_invalid',
              edge_id: edgeId
            })
          };
        }

        const blockingEdge = this._findBlockingEdge(edge);
        if (blockingEdge) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'blocking edge suppresses deal formation', {
              reason_code: 'market_deal_blocked',
              edge_id: edgeId,
              blocking_edge_id: blockingEdge.edge_id
            })
          };
        }

        const existingActive = this._activeDealForEdge(edgeId);
        if (existingActive) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'active deal already exists for edge', {
              reason_code: 'market_deal_conflict',
              edge_id: edgeId,
              deal_id: existingActive.deal_id
            })
          };
        }

        const requestedDealId = normalizeOptionalString(request?.deal?.deal_id);
        const dealId = requestedDealId ?? nextDealId(this.store);
        if (this.store.state.market_deals[dealId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'deal already exists', {
              reason_code: 'market_deal_conflict',
              deal_id: dealId
            })
          };
        }

        const participants = [clone(sourceListing.owner_actor), clone(targetListing.owner_actor)];
        const thread = this._ensureThread({
          workspaceId: edge.workspace_id,
          participants,
          anchorRef: { kind: 'edge', id: edgeId },
          recordedAt,
          threadId: normalizeOptionalString(request?.deal?.thread_id)
        });

        const record = {
          deal_id: dealId,
          workspace_id: edge.workspace_id,
          origin_edge_id: edgeId,
          participants,
          payer_actor: clone(sourceListing.owner_actor),
          payee_actor: clone(targetListing.owner_actor),
          settlement_mode: null,
          status: 'ready_for_settlement',
          terms: isPlainObject(request?.deal?.terms) ? clone(request.deal.terms) : (edge.terms_patch ? clone(edge.terms_patch) : null),
          settlement_ref: null,
          receipt_ref: null,
          payment_proof_id: null,
          thread_id: thread.thread_id,
          created_at: recordedAt,
          updated_at: recordedAt
        };

        this.store.state.market_deals[dealId] = record;
        actorQuota.deals_created = Number(actorQuota.deals_created ?? 0) + 1;
        this._appendSystemMessage({
          threadId: thread.thread_id,
          recordedAt,
          payload: {
            event: 'deal.created',
            deal_id: dealId,
            edge_id: edgeId
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            deal: normalizeDealView(record)
          }
        };
      }
    });
  }

  get({ actor, auth, dealId }) {
    const op = 'marketDeals.get';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const subjectActor = this._subjectActor({ actor, auth });
    const load = this._loadDealOrError({ dealId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };
    const participantGuard = this._ensureParticipant({ deal: load.record, actor: subjectActor, correlationId: corr });
    if (participantGuard) return participantGuard;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        deal: normalizeDealView(load.record)
      }
    };
  }

  list({ actor, auth, query }) {
    const op = 'marketDeals.list';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const normalized = normalizeDealListQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
      };
    }

    const subjectActor = this._subjectActor({ actor, auth });
    const rows = Object.values(this.store.state.market_deals ?? {}).filter(row => {
      if (!includesActor(row.participants, subjectActor)) return false;
      if (normalized.value.workspace_id && row.workspace_id !== normalized.value.workspace_id) return false;
      if (normalized.value.status && row.status !== normalized.value.status) return false;
      if (normalized.value.settlement_mode && row.settlement_mode !== normalized.value.settlement_mode) return false;
      return true;
    });

    sortByUpdatedDescThenId(rows, 'deal_id');
    const page = buildPaginationSlice({
      rows,
      limit: normalized.value.limit,
      cursorAfter: normalized.value.cursor_after,
      keyFn: row => [row.updated_at, row.deal_id],
      cursorParts: 2
    });
    if (!page.ok) {
      return {
        ok: false,
        body: errorResponse(corr, page.code, page.message, page.details)
      };
    }
    return {
      ok: true,
      body: {
        correlation_id: corr,
        deals: page.value.page.map(normalizeDealView),
        total: page.value.total,
        next_cursor: page.value.nextCursor
      }
    };
  }

  startSettlement({ actor, auth, dealId, idempotencyKey, request }) {
    const op = 'marketDeals.startSettlement';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const subjectActor = this._subjectActor({ actor, auth });
        const load = this._loadDealOrError({ dealId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const deal = load.record;
        const participantGuard = this._ensureParticipant({ deal, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid settlement timestamp', {
              reason_code: 'market_deal_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const settlementMode = normalizeOptionalString(request?.settlement_mode)?.toLowerCase() ?? null;
        if (!settlementMode || !SETTLEMENT_MODES.has(settlementMode)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid settlement mode', {
              reason_code: 'market_deal_invalid',
              settlement_mode: request?.settlement_mode ?? null
            })
          };
        }

        if (deal.status !== 'ready_for_settlement') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'deal is not ready for settlement', {
              reason_code: 'market_deal_status_invalid',
              deal_id: dealId,
              status: deal.status
            })
          };
        }

        deal.settlement_mode = settlementMode;
        if (isPlainObject(request?.terms)) {
          deal.terms = { ...(deal.terms ?? {}), ...clone(request.terms) };
        }
        deal.settlement_ref = settlementMode === 'cycle_bridge'
          ? (normalizeOptionalString(request?.cycle_id) ?? `market_cycle_${deal.deal_id}`)
          : `market_settlement_${deal.deal_id}`;
        deal.status = 'settlement_in_progress';
        deal.updated_at = recordedAt;

        this._appendSystemMessage({
          threadId: deal.thread_id,
          recordedAt,
          payload: {
            event: 'deal.settlement_started',
            deal_id: deal.deal_id,
            settlement_mode: deal.settlement_mode,
            settlement_ref: deal.settlement_ref
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            deal: normalizeDealView(deal)
          }
        };
      }
    });
  }

  attachPaymentProof({ actor, auth, dealId, idempotencyKey, request }) {
    const op = 'marketDeals.attachPaymentProof';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const subjectActor = this._subjectActor({ actor, auth });
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid payment proof timestamp', {
              reason_code: 'market_payment_proof_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const dealLoad = this._loadDealOrError({ dealId, correlationId: corr });
        if (!dealLoad.ok) return { ok: false, body: dealLoad.body };
        const deal = dealLoad.record;
        const participantGuard = this._ensureParticipant({ deal, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        if (deal.settlement_mode !== 'external_payment_proof' || (deal.status !== 'settlement_in_progress' && deal.status !== 'ready_for_settlement')) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'deal is not eligible for payment proof', {
              reason_code: 'market_payment_proof_invalid',
              deal_id: dealId,
              settlement_mode: deal.settlement_mode,
              status: deal.status
            })
          };
        }

        const paymentProof = request?.payment_proof;
        if (!isPlainObject(paymentProof)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid payment proof payload', {
              reason_code: 'market_payment_proof_invalid'
            })
          };
        }

        const paymentRail = normalizeOptionalString(paymentProof.payment_rail);
        const proofFingerprint = normalizeOptionalString(paymentProof.proof_fingerprint);
        const attestationRole = normalizeOptionalString(paymentProof.attestation_role)?.toLowerCase() ?? null;
        const externalReference = normalizeOptionalString(paymentProof.external_reference);
        const nonce = normalizeOptionalString(paymentProof.nonce) ?? `nonce_${dealId}`;
        const expiresAt = normalizeOptionalString(paymentProof.expires_at) ?? plusSeconds(recordedAt, ttlSeconds());

        if (!paymentRail || !proofFingerprint || (attestationRole !== 'payer' && attestationRole !== 'payee') || parseIsoMs(expiresAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid payment proof payload', {
              reason_code: 'market_payment_proof_invalid'
            })
          };
        }

        const fingerprintConflict = Object.values(this.store.state.market_payment_proofs ?? {}).find(record => (
          record.proof_fingerprint === proofFingerprint
          && record.deal_id !== dealId
        ));
        if (fingerprintConflict) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'payment proof fingerprint already used', {
              reason_code: 'market_payment_proof_replayed',
              proof_id: fingerprintConflict.proof_id,
              deal_id: fingerprintConflict.deal_id
            })
          };
        }

        let proof = deal.payment_proof_id ? (this.store.state.market_payment_proofs?.[deal.payment_proof_id] ?? null) : null;
        if (!proof) {
          const proofId = normalizeOptionalString(paymentProof.proof_id) ?? nextPaymentProofId(this.store);
          proof = {
            proof_id: proofId,
            deal_id: dealId,
            payment_rail: paymentRail,
            proof_fingerprint: proofFingerprint,
            external_reference: externalReference,
            payer_actor: clone(deal.payer_actor),
            payee_actor: clone(deal.payee_actor),
            payer_attested_at: null,
            payee_attested_at: null,
            nonce,
            expires_at: expiresAt,
            consumed_at: null,
            created_at: recordedAt
          };
          this.store.state.market_payment_proofs[proofId] = proof;
          deal.payment_proof_id = proofId;
        } else if (proof.proof_fingerprint !== proofFingerprint) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'deal already has a different payment proof', {
              reason_code: 'market_payment_proof_conflict',
              proof_id: proof.proof_id
            })
          };
        }

        if (attestationRole === 'payer') {
          if (!actorEquals(subjectActor, deal.payer_actor)) {
            return {
              ok: false,
              body: errorResponse(corr, 'FORBIDDEN', 'payer attestation requires payer actor', {
                reason_code: 'market_payment_proof_forbidden',
                actor: subjectActor,
                payer_actor: deal.payer_actor
              })
            };
          }
          proof.payer_attested_at = proof.payer_attested_at ?? recordedAt;
        } else {
          if (!actorEquals(subjectActor, deal.payee_actor)) {
            return {
              ok: false,
              body: errorResponse(corr, 'FORBIDDEN', 'payee attestation requires payee actor', {
                reason_code: 'market_payment_proof_forbidden',
                actor: subjectActor,
                payee_actor: deal.payee_actor
              })
            };
          }
          proof.payee_attested_at = proof.payee_attested_at ?? recordedAt;
        }

        deal.updated_at = recordedAt;
        this._appendSystemMessage({
          threadId: deal.thread_id,
          recordedAt,
          payload: {
            event: 'deal.payment_proof_attested',
            deal_id: dealId,
            proof_id: proof.proof_id,
            attestation_role: attestationRole
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            payment_proof: normalizePaymentProofView(proof)
          }
        };
      }
    });
  }

  complete({ actor, auth, dealId, idempotencyKey, request }) {
    const op = 'marketDeals.complete';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const subjectActor = this._subjectActor({ actor, auth });
        const load = this._loadDealOrError({ dealId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const deal = load.record;
        const participantGuard = this._ensureParticipant({ deal, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid completion timestamp', {
              reason_code: 'market_deal_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        if (deal.status !== 'settlement_in_progress') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'deal is not in settlement', {
              reason_code: 'market_deal_status_invalid',
              deal_id: dealId,
              status: deal.status
            })
          };
        }

        if (!deal.settlement_mode || !SETTLEMENT_MODES.has(deal.settlement_mode)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'deal settlement mode is missing', {
              reason_code: 'market_deal_invalid',
              deal_id: dealId
            })
          };
        }

        if (deal.settlement_mode === 'internal_credit') {
          const amount = normalizePositiveAmount(deal.terms ?? {});
          const payerQuota = this._ensureActorQuota(deal.payer_actor);
          const payeeQuota = this._ensureActorQuota(deal.payee_actor);
          if (payerQuota.credit_balance < amount) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'insufficient internal credit balance', {
                reason_code: 'market_deal_balance_insufficient',
                deal_id: dealId,
                available_balance: payerQuota.credit_balance,
                required_balance: amount
              })
            };
          }
          payerQuota.credit_balance -= amount;
          payeeQuota.credit_balance += amount;
        }

        if (deal.settlement_mode === 'external_payment_proof') {
          const proof = deal.payment_proof_id ? (this.store.state.market_payment_proofs?.[deal.payment_proof_id] ?? null) : null;
          if (!proof) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'payment proof required before completion', {
                reason_code: 'market_payment_proof_missing',
                deal_id: dealId
              })
            };
          }
          if (proof.consumed_at) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONFLICT', 'payment proof already consumed', {
                reason_code: 'market_payment_proof_replayed',
                proof_id: proof.proof_id,
                consumed_at: proof.consumed_at
              })
            };
          }
          if ((parseIsoMs(proof.expires_at) ?? 0) < (parseIsoMs(recordedAt) ?? 0)) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'payment proof expired', {
                reason_code: 'market_payment_proof_expired',
                proof_id: proof.proof_id,
                expires_at: proof.expires_at
              })
            };
          }
          if (!proof.payer_attested_at || !proof.payee_attested_at) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'payment proof requires dual attestation', {
                reason_code: 'market_payment_proof_unattested',
                proof_id: proof.proof_id
              })
            };
          }
          proof.consumed_at = recordedAt;
        }

        const receipt = this._mintReceipt({ deal, recordedAt, finalState: 'completed' });
        deal.receipt_ref = receipt.id;
        deal.status = 'completed';
        deal.updated_at = recordedAt;

        this._appendSystemMessage({
          threadId: deal.thread_id,
          recordedAt,
          payload: {
            event: 'deal.completed',
            deal_id: deal.deal_id,
            receipt_id: receipt.id
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            deal: normalizeDealView(deal)
          }
        };
      }
    });
  }

  receipt({ actor, auth, dealId }) {
    const op = 'marketDeals.receipt';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadDealOrError({ dealId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };

    const deal = load.record;
    if (!actor) {
      if (!dealIsPublicVisible(this.store, deal) || deal.status !== 'completed') {
        return {
          ok: false,
          body: errorResponse(corr, 'NOT_FOUND', 'receipt not found', {
            reason_code: 'market_receipt_not_found',
            deal_id: dealId
          })
        };
      }
    } else {
      const subjectActor = this._subjectActor({ actor, auth });
      const participantGuard = this._ensureParticipant({ deal, actor: subjectActor, correlationId: corr });
      if (participantGuard) return participantGuard;
    }

    const cycleId = deal.settlement_ref ?? deal.deal_id;
    const receipt = this.store.state.receipts?.[cycleId] ?? null;
    if (!receipt) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'receipt not found', {
          reason_code: 'market_receipt_not_found',
          deal_id: dealId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        receipt: clone(receipt)
      }
    };
  }
}
