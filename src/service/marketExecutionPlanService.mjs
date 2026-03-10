import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { effectiveActorForDelegation } from '../core/tradingPolicyBoundaries.mjs';
import { signReceipt } from '../crypto/receiptSigning.mjs';

const PLAN_TYPES = new Set(['direct', 'cycle', 'mixed_cycle']);
const PLAN_STATUS = new Set([
  'draft',
  'pending_participant_acceptance',
  'ready_for_settlement',
  'settlement_in_progress',
  'completed',
  'failed',
  'cancelled'
]);
const LEG_TYPES = new Set([
  'asset_transfer',
  'service_delivery',
  'blueprint_delivery',
  'credit_transfer',
  'cash_payment',
  'access_grant',
  'verification_only'
]);
const LEG_STATUS = new Set(['pending', 'completed', 'failed']);
const SETTLEMENT_MODES = new Set(['barter', 'internal_credit', 'external_payment_proof', 'cycle_bridge']);

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

function actorProfileKey(actor) {
  if (!actor?.type || !actor?.id) return null;
  return `${actor.type}:${actor.id}`;
}

function includesActor(participants, actor) {
  return Array.isArray(participants) && participants.some(row => actorEquals(row, actor));
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.market_candidates ||= {};
  store.state.market_execution_plans ||= {};
  store.state.market_execution_plan_counter ||= 0;
  store.state.receipts ||= {};
  store.state.market_listings ||= {};
  store.state.market_blueprints ||= {};
}

function nextPlanId(store) {
  store.state.market_execution_plan_counter = Number(store.state.market_execution_plan_counter ?? 0) + 1;
  return `plan_${String(store.state.market_execution_plan_counter).padStart(6, '0')}`;
}

function listingIsPublicVisible(listing) {
  return !!listing && listing.status !== 'suspended';
}

function blueprintIsPublicVisible(blueprint) {
  return !!blueprint && blueprint.status === 'published';
}

function planIsPublicVisible(store, plan) {
  if (!plan || plan.status === 'cancelled') return false;
  return Array.isArray(plan.input_refs) && plan.input_refs.every(ref => {
    if (ref.kind === 'listing') return listingIsPublicVisible(store.state.market_listings?.[ref.id] ?? null);
    if (ref.kind === 'blueprint') return blueprintIsPublicVisible(store.state.market_blueprints?.[ref.id] ?? null);
    return false;
  });
}

function roleAssignmentsFromParticipants(participants) {
  return (participants ?? []).map((participant, index) => ({
    participant_key: actorProfileKey(participant) ?? `participant_${index + 1}`,
    principal: clone(participant),
    executor: clone(participant),
    verifier: null,
    sponsor: null,
    broker: null,
    guarantor: null
  }));
}

function buildPlanObligationGraph(record) {
  return {
    graph_id: `obl_${record.plan_id}`,
    graph_type: 'economic',
    plan_type: record.plan_type,
    participant_roles: roleAssignmentsFromParticipants(record.participants),
    obligations: (record.transfer_legs ?? []).map((leg, index) => ({
      obligation_id: leg.leg_id ?? `obligation_${index + 1}`,
      leg_id: leg.leg_id ?? `leg_${index + 1}`,
      from_principal: clone(leg.from_actor),
      to_principal: clone(leg.to_actor),
      leg_type: leg.leg_type,
      status: leg.status,
      asset_ref: clone(leg.asset_ref ?? null),
      blueprint_ref: clone(leg.blueprint_ref ?? null),
      capability_ref: clone(leg.capability_ref ?? null),
      credit_instrument: clone(leg.credit_instrument ?? null),
      cash_instrument: clone(leg.cash_instrument ?? null),
      valuation: clone(leg.valuation ?? {}),
      blocking: leg.blocking !== false,
      depends_on_leg_ids: clone(leg.depends_on_leg_ids ?? [])
    })),
    acceptance_state: clone(record.acceptance_state ?? {}),
    settlement_policy: clone(record.settlement_policy ?? {}),
    fallback_policy: clone(record.failure_policy ?? {})
  };
}

function buildPlanExecutionGraph(record) {
  return {
    graph_id: `exec_${record.plan_id}`,
    graph_type: 'execution_mapping',
    status: record.status,
    role_assignments: roleAssignmentsFromParticipants(record.participants),
    steps: (record.transfer_legs ?? []).map((leg, index) => ({
      step_id: `step_${index + 1}`,
      leg_id: leg.leg_id ?? `leg_${index + 1}`,
      executor: clone(leg.from_actor),
      verifier: leg.verification_spec?.verifier ?? null,
      status: leg.status,
      deliverable_type: leg.leg_type,
      blocking: leg.blocking !== false,
      depends_on_leg_ids: clone(leg.depends_on_leg_ids ?? [])
    }))
  };
}

function normalizePlanView(record) {
  return {
    plan_id: record.plan_id,
    workspace_id: record.workspace_id,
    origin_candidate_id: record.origin_candidate_id,
    plan_type: record.plan_type,
    status: record.status,
    participants: clone(record.participants),
    input_refs: clone(record.input_refs ?? []),
    transfer_legs: clone(record.transfer_legs),
    acceptance_state: clone(record.acceptance_state ?? {}),
    settlement_policy: clone(record.settlement_policy ?? {}),
    verification_policy: clone(record.verification_policy ?? {}),
    obligation_graph: buildPlanObligationGraph(record),
    execution_graph: buildPlanExecutionGraph(record),
    failure_policy: clone(record.failure_policy ?? {}),
    legacy_bridge: clone(record.legacy_bridge ?? {}),
    receipt_ref: record.receipt_ref ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function inferPlanType(candidateType) {
  if (candidateType === 'direct') return 'direct';
  if (candidateType === 'cycle') return 'cycle';
  return 'mixed_cycle';
}

function planStatusFromAcceptance(acceptanceState) {
  const states = Object.values(acceptanceState ?? {});
  if (states.some(state => state === 'rejected')) return 'cancelled';
  if (states.length > 0 && states.every(state => state === 'accepted')) return 'ready_for_settlement';
  return 'pending_participant_acceptance';
}

function inferSettlementMode(plan) {
  const hasCash = plan.transfer_legs.some(leg => leg.leg_type === 'cash_payment');
  const hasCredit = plan.transfer_legs.some(leg => leg.leg_type === 'credit_transfer');
  if (hasCash) return 'external_payment_proof';
  if (hasCredit) return 'internal_credit';
  if (plan.plan_type === 'cycle' || plan.plan_type === 'mixed_cycle') return 'cycle_bridge';
  return 'barter';
}

function normalizeListQuery(query) {
  const allowed = new Set(['workspace_id', 'status', 'plan_type', 'limit', 'cursor_after']);
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
  const planType = normalizeOptionalString(query?.plan_type)?.toLowerCase() ?? null;
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (status && !PLAN_STATUS.has(status)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid execution plan status filter',
      details: { reason_code: 'market_execution_plan_invalid', status }
    };
  }
  if (planType && !PLAN_TYPES.has(planType)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid execution plan type filter',
      details: { reason_code: 'market_execution_plan_invalid', plan_type: planType }
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
      plan_type: planType,
      limit,
      cursor_after: cursorAfter
    }
  };
}

export class MarketExecutionPlanService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _authorize({ actor, auth, operationId, correlationId: corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };
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
    this.store.state.idempotency[scopeKey] = { payload_hash: requestHash, result: clone(result) };
    return { replayed: false, result };
  }

  _loadCandidateOrError({ candidateId, correlationId: corr }) {
    const record = this.store.state.market_candidates?.[candidateId] ?? null;
    if (!record) {
      return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'candidate not found', { reason_code: 'market_candidate_not_found', candidate_id: candidateId }) };
    }
    return { ok: true, record };
  }

  _loadPlanOrError({ planId, correlationId: corr }) {
    const record = this.store.state.market_execution_plans?.[planId] ?? null;
    if (!record) {
      return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'execution plan not found', { reason_code: 'market_execution_plan_not_found', plan_id: planId }) };
    }
    return { ok: true, record };
  }

  _activePlanForCandidate(candidateId) {
    return Object.values(this.store.state.market_execution_plans ?? {}).find(record => (
      record.origin_candidate_id === candidateId
      && record.status !== 'completed'
      && record.status !== 'failed'
      && record.status !== 'cancelled'
    )) ?? null;
  }

  _ensureParticipant({ plan, actor, correlationId: corr }) {
    if (includesActor(plan?.participants, actor)) return null;
    return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'execution plan participant required', { reason_code: 'market_execution_plan_forbidden', plan_id: plan?.plan_id ?? null, actor }) };
  }

  _ensureLegActor({ plan, leg, actor, correlationId: corr }) {
    if (actorEquals(leg?.from_actor, actor) || actorEquals(leg?.to_actor, actor)) return null;
    return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'execution leg actor required', { reason_code: 'market_execution_plan_forbidden', plan_id: plan?.plan_id ?? null, leg_id: leg?.leg_id ?? null, actor }) };
  }

  _mintReceipt({ plan, recordedAt, finalState = 'completed' }) {
    const bridgeCycleId = normalizeOptionalString(plan.legacy_bridge?.proposal_id);
    if (bridgeCycleId && this.store.state.receipts?.[bridgeCycleId]) {
      return this.store.state.receipts[bridgeCycleId];
    }

    const receiptKey = normalizeOptionalString(plan.settlement_policy?.settlement_ref) ?? plan.plan_id;
    const existing = this.store.state.receipts?.[receiptKey] ?? null;
    if (existing) return existing;

    const unsigned = {
      id: `receipt_${plan.plan_id}`,
      cycle_id: receiptKey,
      final_state: finalState,
      intent_ids: [],
      asset_ids: plan.transfer_legs.map(leg => leg.asset_ref?.asset_id ?? leg.leg_id),
      created_at: recordedAt,
      transparency: {
        market_execution_plan_id: plan.plan_id,
        origin_candidate_id: plan.origin_candidate_id,
        plan_type: plan.plan_type,
        settlement_mode: plan.settlement_policy?.mode ?? null,
        legacy_bridge: clone(plan.legacy_bridge ?? {})
      }
    };
    const signed = { ...unsigned, signature: signReceipt(unsigned) };
    this.store.state.receipts[receiptKey] = signed;
    return signed;
  }

  createFromCandidate({ actor, auth, candidateId, idempotencyKey, request }) {
    const op = 'marketExecutionPlans.createFromCandidate';
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
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid execution plan timestamp', { reason_code: 'market_execution_plan_invalid', recorded_at: request?.recorded_at ?? null }) };
        }

        const candidateLoad = this._loadCandidateOrError({ candidateId, correlationId: corr });
        if (!candidateLoad.ok) return { ok: false, body: candidateLoad.body };
        const candidate = candidateLoad.record;

        if (!candidate.participants?.some(row => actorEquals(row.actor, subjectActor))) {
          return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'candidate participant actor required', { reason_code: 'market_execution_plan_forbidden', candidate_id: candidateId, actor: subjectActor }) };
        }
        if (candidate.status === 'rejected' || candidate.status === 'expired' || candidate.status === 'superseded') {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'candidate is not eligible for execution plan materialization', { reason_code: 'market_execution_plan_invalid', candidate_id: candidateId, status: candidate.status }) };
        }

        const existing = this._activePlanForCandidate(candidateId);
        if (existing) {
          return { ok: false, body: errorResponse(corr, 'CONFLICT', 'active execution plan already exists for candidate', { reason_code: 'market_execution_plan_conflict', candidate_id: candidateId, plan_id: existing.plan_id }) };
        }

        const requestedPlanId = normalizeOptionalString(request?.plan?.plan_id);
        const planId = requestedPlanId ?? nextPlanId(this.store);
        if (this.store.state.market_execution_plans[planId]) {
          return { ok: false, body: errorResponse(corr, 'CONFLICT', 'execution plan already exists', { reason_code: 'market_execution_plan_conflict', plan_id: planId }) };
        }

        const acceptanceState = clone(candidate.acceptance_state ?? {});
        for (const participant of candidate.participants ?? []) {
          const key = actorProfileKey(participant.actor);
          if (key && !acceptanceState[key]) acceptanceState[key] = 'pending';
        }
        const status = planStatusFromAcceptance(acceptanceState);
        const transferLegs = (candidate.legs_preview ?? []).map((leg, index) => ({
          leg_id: normalizeOptionalString(leg.leg_id) ?? `leg_${index + 1}`,
          plan_id: planId,
          leg_type: LEG_TYPES.has(leg.leg_type) ? leg.leg_type : 'asset_transfer',
          from_actor: clone(leg.from_actor),
          to_actor: clone(leg.to_actor),
          input_ref: leg.input_ref ? clone(leg.input_ref) : null,
          asset_ref: leg.asset ? clone(leg.asset) : null,
          blueprint_ref: leg.input_ref?.kind === 'blueprint' ? clone(leg.input_ref) : null,
          capability_ref: leg.leg_type === 'service_delivery' ? clone(leg.input_ref) : null,
          credit_instrument: leg.leg_type === 'credit_transfer' ? { instrument_type: 'internal_credit', currency_or_unit: 'credit', purpose_scope: 'market_trade' } : null,
          cash_instrument: leg.leg_type === 'cash_payment' ? { instrument_type: 'cash', currency_or_unit: 'USD', purpose_scope: 'market_trade' } : null,
          verification_spec: null,
          status: 'pending',
          blocking: leg.blocking !== false,
          depends_on_leg_ids: [],
          valuation: { usd_amount: Number(leg.valuation_usd ?? 0) },
          created_at: recordedAt,
          updated_at: recordedAt
        }));

        const plan = {
          plan_id: planId,
          workspace_id: candidate.workspace_id,
          origin_candidate_id: candidateId,
          plan_type: inferPlanType(candidate.candidate_type),
          status,
          participants: (candidate.participants ?? []).map(row => clone(row.actor)),
          input_refs: clone(candidate.input_refs ?? []),
          transfer_legs: transferLegs,
          acceptance_state: acceptanceState,
          settlement_policy: {
            mode: null,
            settlement_ref: null,
            summary: clone(candidate.settlement_summary ?? {})
          },
          verification_policy: {
            explanation: clone(candidate.explanation ?? []),
            required_proofs: transferLegs.filter(leg => leg.leg_type === 'cash_payment' || leg.leg_type === 'access_grant').map(leg => leg.leg_id)
          },
          failure_policy: {
            on_blocking_leg_failure: 'fail_plan',
            on_non_blocking_leg_failure: 'mark_leg_failed',
            unwind_strategy: candidate.candidate_type === 'direct' ? 'manual_resolution' : 'recompute_or_manual_resolution'
          },
          legacy_bridge: clone(candidate.legacy_refs ?? {}),
          receipt_ref: null,
          created_at: recordedAt,
          updated_at: recordedAt
        };

        this.store.state.market_execution_plans[planId] = plan;
        return { ok: true, body: { correlation_id: corr, plan: normalizePlanView(plan) } };
      }
    });
  }

  get({ actor, auth, planId }) {
    const op = 'marketExecutionPlans.get';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadPlanOrError({ planId, correlationId: corr });
    if (!load.ok) return load;
    const plan = load.record;
    const subjectActor = this._subjectActor({ actor, auth });
    const isPublic = planIsPublicVisible(this.store, plan) && plan.status !== 'draft';
    const isParticipant = plan.participants.some(row => actorEquals(row, subjectActor));
    if (!isPublic && !isParticipant) {
      return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'execution plan not found', { reason_code: 'market_execution_plan_not_found', plan_id: planId }) };
    }
    return { ok: true, body: { correlation_id: corr, plan: normalizePlanView(plan) } };
  }

  list({ actor, auth, query }) {
    const op = 'marketExecutionPlans.list';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const normalized = normalizeListQuery(query ?? {});
    if (!normalized.ok) return { ok: false, body: errorResponse(corr, normalized.code, normalized.message, normalized.details) };

    const subjectActor = this._subjectActor({ actor, auth });
    const rows = Object.values(this.store.state.market_execution_plans ?? {}).filter(plan => {
      if (!plan) return false;
      if (normalized.value.workspace_id && plan.workspace_id !== normalized.value.workspace_id) return false;
      if (normalized.value.status && plan.status !== normalized.value.status) return false;
      if (normalized.value.plan_type && plan.plan_type !== normalized.value.plan_type) return false;
      const isPublic = planIsPublicVisible(this.store, plan) && plan.status !== 'draft';
      const isParticipant = includesActor(plan.participants, subjectActor);
      return isPublic || isParticipant;
    }).map(plan => normalizePlanView(plan));

    sortByUpdatedDescThenId(rows, 'plan_id');
    const page = buildPaginationSlice({ rows, limit: normalized.value.limit, cursorAfter: normalized.value.cursor_after, keyFn: row => [row.updated_at, row.plan_id], cursorParts: 2 });
    if (!page.ok) return { ok: false, body: errorResponse(corr, page.code, page.message, page.details) };
    return { ok: true, body: { correlation_id: corr, plans: page.value.page, total: page.value.total, next_cursor: page.value.nextCursor } };
  }

  _transitionAcceptance({ actor, auth, planId, idempotencyKey, request, operationId, targetState }) {
    const corr = correlationId(operationId);
    const authz = this._authorize({ actor, auth, operationId, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadPlanOrError({ planId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const plan = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        const participantGuard = this._ensureParticipant({ plan, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid execution plan timestamp', { reason_code: 'market_execution_plan_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (!['pending_participant_acceptance', 'ready_for_settlement'].includes(plan.status)) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution plan is not awaiting participant decision', { reason_code: 'market_execution_plan_status_invalid', plan_id: planId, status: plan.status }) };
        }

        plan.acceptance_state[actorProfileKey(subjectActor)] = targetState;
        plan.status = planStatusFromAcceptance(plan.acceptance_state);
        plan.updated_at = recordedAt;
        return { ok: true, body: { correlation_id: corr, plan: normalizePlanView(plan) } };
      }
    });
  }

  accept({ actor, auth, planId, idempotencyKey, request }) {
    return this._transitionAcceptance({ actor, auth, planId, idempotencyKey, request, operationId: 'marketExecutionPlans.accept', targetState: 'accepted' });
  }

  decline({ actor, auth, planId, idempotencyKey, request }) {
    return this._transitionAcceptance({ actor, auth, planId, idempotencyKey, request, operationId: 'marketExecutionPlans.decline', targetState: 'rejected' });
  }

  startSettlement({ actor, auth, planId, idempotencyKey, request }) {
    const op = 'marketExecutionPlans.startSettlement';
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
        const load = this._loadPlanOrError({ planId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const plan = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        const participantGuard = this._ensureParticipant({ plan, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid settlement timestamp', { reason_code: 'market_execution_plan_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (plan.status !== 'ready_for_settlement') {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution plan is not ready for settlement', { reason_code: 'market_execution_plan_status_invalid', plan_id: planId, status: plan.status }) };
        }

        const settlementMode = normalizeOptionalString(request?.settlement_mode)?.toLowerCase() ?? inferSettlementMode(plan);
        if (!SETTLEMENT_MODES.has(settlementMode)) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid settlement mode', { reason_code: 'market_execution_plan_invalid', settlement_mode: request?.settlement_mode ?? null }) };
        }

        plan.settlement_policy = {
          ...(plan.settlement_policy ?? {}),
          mode: settlementMode,
          settlement_ref: settlementMode === 'cycle_bridge'
            ? (normalizeOptionalString(request?.cycle_id) ?? normalizeOptionalString(plan.legacy_bridge?.proposal_id) ?? `market_cycle_${plan.plan_id}`)
            : `market_plan_${plan.plan_id}`,
          terms: isPlainObject(request?.terms) ? clone(request.terms) : (plan.settlement_policy?.terms ?? null)
        };
        plan.status = 'settlement_in_progress';
        plan.updated_at = recordedAt;
        return { ok: true, body: { correlation_id: corr, plan: normalizePlanView(plan) } };
      }
    });
  }

  completeLeg({ actor, auth, planId, legId, idempotencyKey, request }) {
    const op = 'marketExecutionPlans.completeLeg';
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
        const load = this._loadPlanOrError({ planId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const plan = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        const participantGuard = this._ensureParticipant({ plan, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid leg completion timestamp', { reason_code: 'market_execution_plan_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (plan.status !== 'settlement_in_progress') {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution plan is not in settlement', { reason_code: 'market_execution_plan_status_invalid', plan_id: planId, status: plan.status }) };
        }

        const leg = plan.transfer_legs.find(row => row.leg_id === legId) ?? null;
        if (!leg) {
          return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'execution leg not found', { reason_code: 'market_execution_plan_leg_not_found', plan_id: planId, leg_id: legId }) };
        }
        const legGuard = this._ensureLegActor({ plan, leg, actor: subjectActor, correlationId: corr });
        if (legGuard) return legGuard;
        if (leg.status === 'completed') {
          return { ok: false, body: errorResponse(corr, 'CONFLICT', 'execution leg already completed', { reason_code: 'market_execution_plan_leg_conflict', plan_id: planId, leg_id: legId, status: leg.status }) };
        }
        if (leg.status === 'failed') {
          return { ok: false, body: errorResponse(corr, 'CONFLICT', 'execution leg already failed', { reason_code: 'market_execution_plan_leg_conflict', plan_id: planId, leg_id: legId, status: leg.status }) };
        }
        const unmetDependency = (leg.depends_on_leg_ids ?? []).find(depId => {
          const dep = plan.transfer_legs.find(row => row.leg_id === depId);
          return dep && dep.status !== 'completed';
        });
        if (unmetDependency) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution leg dependency not completed', { reason_code: 'market_execution_plan_leg_dependency_unmet', plan_id: planId, leg_id: legId, depends_on_leg_id: unmetDependency }) };
        }

        leg.status = 'completed';
        leg.verification_result = isPlainObject(request?.verification_result) ? clone(request.verification_result) : null;
        leg.updated_at = recordedAt;
        plan.updated_at = recordedAt;

        const blockingPending = plan.transfer_legs.some(row => row.blocking && row.status !== 'completed');
        if (!blockingPending) {
          const receipt = this._mintReceipt({ plan, recordedAt, finalState: 'completed' });
          plan.receipt_ref = receipt.id;
          plan.status = 'completed';
        }
        return { ok: true, body: { correlation_id: corr, plan: normalizePlanView(plan) } };
      }
    });
  }

  failLeg({ actor, auth, planId, legId, idempotencyKey, request }) {
    const op = 'marketExecutionPlans.failLeg';
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
        const load = this._loadPlanOrError({ planId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const plan = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        const participantGuard = this._ensureParticipant({ plan, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid leg failure timestamp', { reason_code: 'market_execution_plan_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (plan.status !== 'settlement_in_progress') {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution plan is not in settlement', { reason_code: 'market_execution_plan_status_invalid', plan_id: planId, status: plan.status }) };
        }

        const leg = plan.transfer_legs.find(row => row.leg_id === legId) ?? null;
        if (!leg) {
          return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'execution leg not found', { reason_code: 'market_execution_plan_leg_not_found', plan_id: planId, leg_id: legId }) };
        }
        const legGuard = this._ensureLegActor({ plan, leg, actor: subjectActor, correlationId: corr });
        if (legGuard) return legGuard;
        if (leg.status !== 'pending') {
          return { ok: false, body: errorResponse(corr, 'CONFLICT', 'execution leg cannot transition to failed', { reason_code: 'market_execution_plan_leg_conflict', plan_id: planId, leg_id: legId, status: leg.status }) };
        }

        leg.status = 'failed';
        leg.failure_reason = normalizeOptionalString(request?.failure_reason) ?? 'execution_leg_failed';
        leg.updated_at = recordedAt;
        plan.status = 'failed';
        plan.updated_at = recordedAt;
        return { ok: true, body: { correlation_id: corr, plan: normalizePlanView(plan) } };
      }
    });
  }

  receipt({ actor, auth, planId }) {
    const op = 'marketExecutionPlans.receipt';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadPlanOrError({ planId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };
    const plan = load.record;

    if (!actor) {
      if (!planIsPublicVisible(this.store, plan) || plan.status !== 'completed') {
        return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'receipt not found', { reason_code: 'market_receipt_not_found', plan_id: planId }) };
      }
    } else {
      const subjectActor = this._subjectActor({ actor, auth });
      const participantGuard = this._ensureParticipant({ plan, actor: subjectActor, correlationId: corr });
      if (participantGuard) return participantGuard;
    }

    const receiptKey = normalizeOptionalString(plan.settlement_policy?.settlement_ref) ?? normalizeOptionalString(plan.legacy_bridge?.proposal_id) ?? plan.plan_id;
    const receipt = this.store.state.receipts?.[receiptKey] ?? this.store.state.receipts?.[plan.plan_id] ?? null;
    if (!receipt) {
      return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'receipt not found', { reason_code: 'market_receipt_not_found', plan_id: planId }) };
    }
    return { ok: true, body: { correlation_id: corr, receipt: clone(receipt) } };
  }
}
