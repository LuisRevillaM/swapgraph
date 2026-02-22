import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const LISTING_STATUSES = new Set(['active', 'cancelled']);
const RISK_TIERS = new Set(['low', 'medium', 'high', 'critical']);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

function parseBps(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return n;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.liquidity_listings ||= {};
  store.state.liquidity_decisions ||= {};
  store.state.liquidity_decision_counter ||= 0;
}

function nextDecisionId(store) {
  store.state.liquidity_decision_counter += 1;
  return `lpdec_${String(store.state.liquidity_decision_counter).padStart(6, '0')}`;
}

function normalizeReasonCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const out = [];
  for (const code of codes) {
    const value = normalizeOptionalString(code);
    if (!value) return null;
    out.push(value);
  }
  const unique = Array.from(new Set(out)).sort();
  return unique.length > 0 ? unique : null;
}

function normalizePolicyRef(policyRef) {
  if (!isObject(policyRef)) return null;
  const policyId = normalizeOptionalString(policyRef.policy_id);
  const policyVersion = Number.parseInt(String(policyRef.policy_version ?? ''), 10);
  const policyMode = normalizeOptionalString(policyRef.policy_mode);
  const constraintsHash = normalizeOptionalString(policyRef.constraints_hash);

  if (!policyId || !Number.isFinite(policyVersion) || policyVersion < 1 || !policyMode || !constraintsHash) {
    return null;
  }

  return {
    policy_id: policyId,
    policy_version: policyVersion,
    policy_mode: policyMode,
    constraints_hash: constraintsHash
  };
}

function policyRefEqual(left, right) {
  if (!left || !right) return false;
  return left.policy_id === right.policy_id
    && left.policy_version === right.policy_version
    && left.policy_mode === right.policy_mode
    && left.constraints_hash === right.constraints_hash;
}

function listingView(listing) {
  return {
    intent_id: listing.intent_id,
    provider_id: listing.provider_id,
    status: listing.status,
    intent: clone(listing.intent),
    policy_ref: clone(listing.policy_ref),
    listed_at: listing.listed_at,
    updated_at: listing.updated_at,
    cancelled_at: listing.cancelled_at ?? null,
    cancel_reason_code: listing.cancel_reason_code ?? null
  };
}

function decisionView(decision) {
  return {
    decision_id: decision.decision_id,
    provider_id: decision.provider_id,
    proposal_id: decision.proposal_id,
    intent_ids: clone(decision.intent_ids),
    commit_id: decision.commit_id ?? null,
    decision: decision.decision,
    decision_reason_codes: clone(decision.decision_reason_codes),
    policy_ref: clone(decision.policy_ref),
    confidence_score_bps: decision.confidence_score_bps,
    risk_tier_snapshot: decision.risk_tier_snapshot,
    correlation_id: decision.correlation_id,
    recorded_at: decision.recorded_at,
    recorded_by: clone(decision.recorded_by),
    trust_safety_decision_id: decision.trust_safety_decision_id ?? null
  };
}

function providerOwnerMismatch(actor, provider) {
  return actor?.type !== provider?.owner_actor?.type || actor?.id !== provider?.owner_actor?.id;
}

function listingSort(a, b) {
  const aMs = parseIsoMs(a?.updated_at) ?? 0;
  const bMs = parseIsoMs(b?.updated_at) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.intent_id ?? '').localeCompare(String(b?.intent_id ?? ''));
}

function trustSafetyDecisionSort(a, b) {
  const aMs = parseIsoMs(a?.recorded_at) ?? 0;
  const bMs = parseIsoMs(b?.recorded_at) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.decision_id ?? '').localeCompare(String(b?.decision_id ?? ''));
}

export class LiquidityListingDecisionService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _nowIso(auth) {
    return normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
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

  _requirePartner({ actor, operationId, correlationId: corr, reasonCode }) {
    if (actor?.type === 'partner' && normalizeOptionalString(actor?.id)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for liquidity listing/decision operations', {
        operation_id: operationId,
        reason_code: reasonCode,
        actor: actor ?? null
      })
    };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, scopeSuffix = null, handler }) {
    const operationScope = scopeSuffix ? `${operationId}:${scopeSuffix}` : operationId;
    const scopeKey = idempotencyScopeKey({ actor, operationId: operationScope, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return { replayed: true, result: clone(existing.result) };
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

  _resolveProviderForActor({ actor, providerId, correlationId: corr, invalidReasonCode }) {
    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: invalidReasonCode
        })
      };
    }

    const provider = this.store.state.liquidity_providers?.[normalizedProviderId];
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity provider not found', {
          reason_code: 'liquidity_provider_not_found',
          provider_id: normalizedProviderId
        })
      };
    }

    if (providerOwnerMismatch(actor, provider)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'liquidity provider ownership mismatch', {
          reason_code: 'liquidity_provider_actor_mismatch',
          provider_id: normalizedProviderId,
          actor,
          owner_actor: provider.owner_actor
        })
      };
    }

    return { ok: true, provider_id: normalizedProviderId, provider };
  }

  _providerListings(providerId) {
    this.store.state.liquidity_listings[providerId] ||= {};
    return this.store.state.liquidity_listings[providerId];
  }

  _latestTrustSafetyDecisionForActor(actor) {
    const partnerId = normalizeOptionalString(actor?.id);
    if (!partnerId) return null;
    const decisions = Object.values(this.store.state.trust_safety_decisions ?? {})
      .filter(decision => decision?.subject_actor_type === 'partner' && decision?.subject_actor_id === partnerId)
      .sort(trustSafetyDecisionSort);
    return decisions.at(-1) ?? null;
  }

  upsertListing({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityListings.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_listing_invalid'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolved = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_listing_invalid'
    });
    if (!resolved.ok) return { replayed: false, result: { ok: false, body: resolved.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      scopeSuffix: resolved.provider_id,
      handler: () => {
        const listingPayload = request?.listing;
        if (!isObject(listingPayload)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity listing payload', {
              reason_code: 'liquidity_listing_invalid'
            })
          };
        }

        const listedAt = normalizeOptionalString(listingPayload?.listed_at) ?? this._nowIso(auth);
        if (parseIsoMs(listedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing timestamp', {
              reason_code: 'liquidity_listing_invalid',
              listed_at: listingPayload?.listed_at ?? null
            })
          };
        }

        const intent = listingPayload.intent;
        if (!isObject(intent)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'listing intent payload is required', {
              reason_code: 'liquidity_listing_invalid'
            })
          };
        }

        const intentId = normalizeOptionalString(intent.id);
        if (!intentId) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'listing intent id is required', {
              reason_code: 'liquidity_listing_invalid'
            })
          };
        }

        const intentActorType = normalizeOptionalString(intent?.actor?.type);
        const intentActorId = normalizeOptionalString(intent?.actor?.id);
        if (intentActorType !== 'partner' || intentActorId !== actor.id) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'listing intent actor must match provider owner', {
              reason_code: 'liquidity_listing_policy_violation',
              intent_actor: intent?.actor ?? null,
              owner_actor: resolved.provider.owner_actor
            })
          };
        }

        const policyRef = normalizePolicyRef(listingPayload.policy_ref ?? resolved.provider.policy_ref);
        if (!policyRef) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'listing policy reference is required', {
              reason_code: 'liquidity_listing_invalid'
            })
          };
        }

        const providerPolicyRef = normalizePolicyRef(resolved.provider.policy_ref);
        if (providerPolicyRef && !policyRefEqual(policyRef, providerPolicyRef)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'listing policy does not match provider policy', {
              reason_code: 'liquidity_listing_policy_violation',
              provider_id: resolved.provider_id
            })
          };
        }

        if (resolved.provider.active === false) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'inactive providers cannot publish listings', {
              reason_code: 'liquidity_listing_policy_violation',
              provider_id: resolved.provider_id
            })
          };
        }

        const intentProviderId = normalizeOptionalString(intent?.liquidity_provider_ref?.provider_id);
        if (intentProviderId && intentProviderId !== resolved.provider_id) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'listing intent liquidity provider mismatch', {
              reason_code: 'liquidity_listing_policy_violation',
              provider_id: resolved.provider_id,
              intent_provider_id: intentProviderId
            })
          };
        }

        const listings = this._providerListings(resolved.provider_id);
        const existing = listings[intentId] ?? null;
        const nextIntent = clone(intent);
        nextIntent.status = 'active';
        nextIntent.liquidity_provider_ref = clone(resolved.provider);
        nextIntent.liquidity_policy_ref = clone(policyRef);
        if (resolved.provider.persona_ref) {
          nextIntent.persona_ref = clone(resolved.provider.persona_ref);
        }

        const next = {
          provider_id: resolved.provider_id,
          intent_id: intentId,
          status: 'active',
          intent: nextIntent,
          policy_ref: clone(policyRef),
          listed_at: existing?.listed_at ?? listedAt,
          updated_at: listedAt,
          cancelled_at: null,
          cancel_reason_code: null
        };
        listings[intentId] = next;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolved.provider_id,
            listing: listingView(next)
          }
        };
      }
    });
  }

  cancelListing({ actor, auth, providerId, intentId, idempotencyKey, request }) {
    const op = 'liquidityListings.cancel';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_listing_invalid'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolved = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_listing_invalid'
    });
    if (!resolved.ok) return { replayed: false, result: { ok: false, body: resolved.body } };

    const normalizedIntentId = normalizeOptionalString(intentId);
    if (!normalizedIntentId) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'intent_id is required', {
            reason_code: 'liquidity_listing_invalid'
          })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      scopeSuffix: `${resolved.provider_id}:${normalizedIntentId}`,
      handler: () => {
        const cancel = request?.cancel;
        if (!isObject(cancel)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cancel payload is required', {
              reason_code: 'liquidity_listing_invalid'
            })
          };
        }

        const cancelledAt = normalizeOptionalString(cancel.cancelled_at) ?? this._nowIso(auth);
        if (parseIsoMs(cancelledAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid cancellation timestamp', {
              reason_code: 'liquidity_listing_invalid',
              cancelled_at: cancel.cancelled_at ?? null
            })
          };
        }

        const cancelReasonCode = normalizeOptionalString(cancel.reason_code);
        if (!cancelReasonCode) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cancel reason_code is required', {
              reason_code: 'liquidity_listing_invalid'
            })
          };
        }

        const listings = this._providerListings(resolved.provider_id);
        const listing = listings[normalizedIntentId] ?? null;
        if (!listing) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'liquidity listing not found', {
              reason_code: 'liquidity_listing_not_found',
              provider_id: resolved.provider_id,
              intent_id: normalizedIntentId
            })
          };
        }

        if (listing.status !== 'cancelled') {
          listing.status = 'cancelled';
          listing.updated_at = cancelledAt;
          listing.cancelled_at = cancelledAt;
          listing.cancel_reason_code = cancelReasonCode;
          if (isObject(listing.intent)) {
            listing.intent.status = 'cancelled';
          }
        }

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolved.provider_id,
            listing: listingView(listing)
          }
        };
      }
    });
  }

  listListings({ actor, auth, providerId, query }) {
    const op = 'liquidityListings.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_listing_invalid'
    });
    if (partnerGuard) return { ok: false, body: partnerGuard.body };

    const resolved = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_listing_invalid'
    });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    const allowedQuery = new Set(['status', 'limit']);
    const unknownQueryParams = Object.keys(query ?? {}).filter(key => !allowedQuery.has(key));
    if (unknownQueryParams.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing query', {
          reason_code: 'liquidity_listing_invalid',
          unknown_query_params: unknownQueryParams.sort()
        })
      };
    }

    const statusFilter = normalizeOptionalString(query?.status);
    if (statusFilter && !LISTING_STATUSES.has(statusFilter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing status filter', {
          reason_code: 'liquidity_listing_invalid',
          status: statusFilter
        })
      };
    }

    const limit = parseLimit(query?.limit, 50);
    if (limit === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing limit', {
          reason_code: 'liquidity_listing_invalid',
          limit: query?.limit ?? null
        })
      };
    }

    let listings = Object.values(this._providerListings(resolved.provider_id)).sort(listingSort);
    if (statusFilter) listings = listings.filter(listing => listing.status === statusFilter);

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolved.provider_id,
        listings: listings.slice(0, limit).map(listingView)
      }
    };
  }

  _recordDecision({ actor, auth, providerId, proposalId, idempotencyKey, request, decisionType, operationId }) {
    const corr = correlationId(operationId);

    const authz = this._authorize({ actor, auth, operationId, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId,
      correlationId: corr,
      reasonCode: 'liquidity_decision_invalid'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolved = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_decision_invalid'
    });
    if (!resolved.ok) return { replayed: false, result: { ok: false, body: resolved.body } };

    const normalizedProposalId = normalizeOptionalString(proposalId);
    if (!normalizedProposalId) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'proposal_id is required', {
            reason_code: 'liquidity_decision_invalid'
          })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      scopeSuffix: `${resolved.provider_id}:${normalizedProposalId}`,
      handler: () => {
        const decision = request?.decision;
        if (!isObject(decision)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity decision payload', {
              reason_code: 'liquidity_decision_invalid'
            })
          };
        }

        const proposal = this.store.state.proposals?.[normalizedProposalId] ?? null;
        if (!proposal || !Array.isArray(proposal.participants)) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'liquidity proposal not found', {
              reason_code: 'liquidity_decision_not_found',
              provider_id: resolved.provider_id,
              proposal_id: normalizedProposalId
            })
          };
        }

        const providerParticipants = proposal.participants
          .filter(participant => normalizeOptionalString(participant?.liquidity_provider_ref?.provider_id) === resolved.provider_id);
        const intentIds = Array.from(new Set(providerParticipants
          .map(participant => normalizeOptionalString(participant?.intent_id))
          .filter(Boolean)))
          .sort();
        if (intentIds.length === 0) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'liquidity proposal not found for provider', {
              reason_code: 'liquidity_decision_not_found',
              provider_id: resolved.provider_id,
              proposal_id: normalizedProposalId
            })
          };
        }

        const policyRef = normalizePolicyRef(decision.policy_ref);
        if (!policyRef) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'liquidity decision policy reference is missing or invalid', {
              reason_code: 'liquidity_decision_policy_missing',
              provider_id: resolved.provider_id,
              proposal_id: normalizedProposalId
            })
          };
        }

        const providerPolicyRef = normalizePolicyRef(resolved.provider.policy_ref);
        if (providerPolicyRef && !policyRefEqual(policyRef, providerPolicyRef)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'liquidity decision policy does not match provider policy', {
              reason_code: 'liquidity_decision_policy_missing',
              provider_id: resolved.provider_id,
              proposal_id: normalizedProposalId
            })
          };
        }

        const confidenceScoreBps = parseBps(decision.confidence_score_bps);
        const riskTierSnapshot = normalizeOptionalString(decision.risk_tier_snapshot);
        const decisionReasonCodes = normalizeReasonCodes(decision.decision_reason_codes);
        const decisionCorrelationId = normalizeOptionalString(decision.correlation_id);
        const recordedAt = normalizeOptionalString(decision.recorded_at) ?? this._nowIso(auth);

        if (confidenceScoreBps === null || !riskTierSnapshot || !RISK_TIERS.has(riskTierSnapshot)
          || !decisionReasonCodes || !decisionCorrelationId || parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity decision payload', {
              reason_code: 'liquidity_decision_invalid'
            })
          };
        }

        const trustSafetyDecision = this._latestTrustSafetyDecisionForActor(actor);
        if (!trustSafetyDecision || trustSafetyDecision.decision !== 'allow') {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'trust/safety policy does not allow this liquidity decision', {
              reason_code: 'liquidity_decision_policy_missing',
              provider_id: resolved.provider_id,
              proposal_id: normalizedProposalId,
              trust_safety_decision_id: trustSafetyDecision?.decision_id ?? null,
              trust_safety_outcome: trustSafetyDecision?.decision ?? null
            })
          };
        }

        const requestedDecisionId = normalizeOptionalString(decision.decision_id);
        const decisionId = requestedDecisionId ?? nextDecisionId(this.store);
        if (this.store.state.liquidity_decisions[decisionId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'decision_id already exists', {
              reason_code: 'liquidity_decision_invalid',
              decision_id: decisionId
            })
          };
        }

        const commit = Object.values(this.store.state.commits ?? {})
          .find(row => normalizeOptionalString(row?.cycle_id) === normalizedProposalId);
        const commitId = normalizeOptionalString(commit?.id) ?? null;

        const record = {
          decision_id: decisionId,
          provider_id: resolved.provider_id,
          proposal_id: normalizedProposalId,
          intent_ids: intentIds,
          commit_id: commitId,
          decision: decisionType,
          decision_reason_codes: decisionReasonCodes,
          policy_ref: clone(policyRef),
          confidence_score_bps: confidenceScoreBps,
          risk_tier_snapshot: riskTierSnapshot,
          correlation_id: decisionCorrelationId,
          recorded_at: recordedAt,
          recorded_by: clone(actor),
          trust_safety_decision_id: trustSafetyDecision.decision_id ?? null
        };

        this.store.state.liquidity_decisions[decisionId] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolved.provider_id,
            decision: decisionView(record)
          }
        };
      }
    });
  }

  acceptProposalDecision({ actor, auth, providerId, proposalId, idempotencyKey, request }) {
    return this._recordDecision({
      actor,
      auth,
      providerId,
      proposalId,
      idempotencyKey,
      request,
      decisionType: 'accept',
      operationId: 'liquidityDecisions.proposal.accept'
    });
  }

  declineProposalDecision({ actor, auth, providerId, proposalId, idempotencyKey, request }) {
    return this._recordDecision({
      actor,
      auth,
      providerId,
      proposalId,
      idempotencyKey,
      request,
      decisionType: 'decline',
      operationId: 'liquidityDecisions.proposal.decline'
    });
  }

  getDecision({ actor, auth, providerId, decisionId }) {
    const op = 'liquidityDecisions.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_decision_invalid'
    });
    if (partnerGuard) return { ok: false, body: partnerGuard.body };

    const resolved = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_decision_invalid'
    });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    const normalizedDecisionId = normalizeOptionalString(decisionId);
    if (!normalizedDecisionId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'decision_id is required', {
          reason_code: 'liquidity_decision_invalid'
        })
      };
    }

    const decision = this.store.state.liquidity_decisions?.[normalizedDecisionId] ?? null;
    if (!decision || decision.provider_id !== resolved.provider_id) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity decision not found', {
          reason_code: 'liquidity_decision_not_found',
          provider_id: resolved.provider_id,
          decision_id: normalizedDecisionId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolved.provider_id,
        decision: decisionView(decision)
      }
    };
  }
}
