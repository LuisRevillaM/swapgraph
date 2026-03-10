import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { effectiveActorForDelegation } from '../core/tradingPolicyBoundaries.mjs';
import { runMatching } from '../matching/engine.mjs';

const CANDIDATE_TYPES = new Set(['direct', 'cycle', 'mixed']);
const CANDIDATE_STATUS = new Set(['open', 'awaiting_acceptance', 'accepted', 'rejected', 'expired', 'superseded']);

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

function resolveSubjectActor({ actor, auth }) {
  return effectiveActorForDelegation({ actor, auth }) ?? actor;
}

function normalizeRecordedAt(request, auth) {
  return normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.market_candidates ||= {};
  store.state.market_blueprints ||= {};
  store.state.market_listings ||= {};
  store.state.market_edges ||= {};
  store.state.market_actor_profiles ||= {};
}

function actorProfileSummary(store, actor) {
  const record = store.state.market_actor_profiles?.[actorProfileKey(actor)] ?? null;
  if (!record) return null;
  return {
    actor: clone(record.actor),
    display_name: record.display_name,
    handle: record.handle,
    owner_mode: record.owner_mode,
    default_workspace_id: record.default_workspace_id,
    bio: record.bio ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function makeCandidateId(proposalId) {
  const suffix = String(proposalId ?? '').replace(/[^a-zA-Z0-9_]+/g, '_');
  return `candidate_${suffix}`;
}

function buildHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function publicVisibleListing(listing) {
  return !!listing && listing.status !== 'suspended';
}

function publicVisibleBlueprint(blueprint) {
  return !!blueprint && blueprint.status === 'published';
}

function publicVisibleCandidate(store, candidate) {
  if (!candidate || candidate.status === 'rejected') return false;
  return Array.isArray(candidate.input_refs) && candidate.input_refs.every(ref => {
    if (ref.kind === 'listing') return publicVisibleListing(store.state.market_listings?.[ref.id] ?? null);
    if (ref.kind === 'blueprint') return publicVisibleBlueprint(store.state.market_blueprints?.[ref.id] ?? null);
    return false;
  });
}

function normalizeProposalExpiresAt(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized === '1970-01-01T00:00:00.000Z' ? null : normalized;
}

function inferValueHintUsd(value) {
  if (!isPlainObject(value)) return null;
  const candidates = [
    value.usd_amount,
    value.usd_total,
    value.amount_usd,
    value.amount,
    value.price_usd,
    value.credit_amount
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function budgetAsOfferAsset(listing) {
  const amount = inferValueHintUsd(listing?.budget);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    asset: {
      platform: 'market',
      asset_id: `budget_${listing.listing_id}`,
      metadata: {
        category: 'cash_usd',
        class: 'cash_budget',
        source_kind: 'listing',
        source_id: listing.listing_id
      }
    },
    value_usd: amount,
    descriptor: {
      leg_type: 'cash_payment',
      source_kind: 'listing',
      source_id: listing.listing_id,
      title: listing.title
    }
  };
}

function compensationWantSpecFromUsd(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return {
    type: 'set',
    any_of: [
      { type: 'category', category: 'cash_usd' },
      { type: 'category', category: 'credit_general' }
    ]
  };
}

function normalizedOfferAssetsFromListing(listing) {
  const out = [];
  for (const [idx, row] of (listing.offer ?? []).entries()) {
    if (!isPlainObject(row)) continue;
    const assetId = normalizeOptionalString(row.asset_id) ?? `${listing.listing_id}_offer_${idx + 1}`;
    const platform = normalizeOptionalString(row.platform) ?? 'market';
    const metadata = isPlainObject(row.metadata) ? clone(row.metadata) : {};
    metadata.category ||= normalizeOptionalString(row.category) ?? normalizeOptionalString(row.class) ?? `listing:${listing.kind}`;
    metadata.source_kind = 'listing';
    metadata.source_id = listing.listing_id;
    const asset = {
      ...clone(row),
      platform,
      asset_id: assetId,
      metadata
    };
    const valueUsd = inferValueHintUsd(row) ?? inferValueHintUsd(metadata) ?? inferValueHintUsd(listing.valuation_hint) ?? 1;
    out.push({
      asset,
      value_usd: valueUsd,
      descriptor: {
        leg_type: 'asset_transfer',
        source_kind: 'listing',
        source_id: listing.listing_id,
        title: listing.title
      }
    });
  }
  return out;
}

function capabilityAsOfferAsset(listing) {
  const rateCard = listing.capability_profile?.rate_card;
  const usd = inferValueHintUsd(rateCard) ?? inferValueHintUsd(listing.valuation_hint) ?? 25;
  return {
    asset: {
      platform: 'market',
      asset_id: `capability_${listing.listing_id}`,
      metadata: {
        category: `capability:${normalizeOptionalString(listing.capability_profile?.deliverable_schema?.category) ?? 'general'}`,
        class: 'service_delivery',
        source_kind: 'listing',
        source_id: listing.listing_id
      }
    },
    value_usd: usd,
    descriptor: {
      leg_type: 'service_delivery',
      source_kind: 'listing',
      source_id: listing.listing_id,
      title: listing.title
    }
  };
}

function blueprintAsOfferAsset(blueprint) {
  const usd = inferValueHintUsd(blueprint.valuation_hint) ?? 15;
  return {
    asset: {
      platform: 'market',
      asset_id: `blueprint_${blueprint.blueprint_id}`,
      metadata: {
        category: `blueprint:${blueprint.category}`,
        class: 'blueprint_delivery',
        source_kind: 'blueprint',
        source_id: blueprint.blueprint_id
      }
    },
    value_usd: usd,
    descriptor: {
      leg_type: 'blueprint_delivery',
      source_kind: 'blueprint',
      source_id: blueprint.blueprint_id,
      title: blueprint.title
    }
  };
}

function listingToIntent(listing) {
  if (!listing || listing.status !== 'open') return null;
  const offerRows = [];
  if (listing.kind === 'want') {
    const budgetAsset = budgetAsOfferAsset(listing);
    if (budgetAsset) offerRows.push(budgetAsset);
  } else if (listing.kind === 'post') {
    offerRows.push(...normalizedOfferAssetsFromListing(listing));
  } else if (listing.kind === 'capability') {
    offerRows.push(capabilityAsOfferAsset(listing));
  }
  if (offerRows.length === 0) return null;

  const offer = offerRows.map(row => row.asset);
  const wantSpec = isPlainObject(listing.want_spec)
    ? clone(listing.want_spec)
    : compensationWantSpecFromUsd(
      listing.kind === 'capability'
        ? inferValueHintUsd(listing.capability_profile?.rate_card) ?? inferValueHintUsd(listing.valuation_hint)
        : inferValueHintUsd(listing.valuation_hint)
    );
  if (!wantSpec) return null;

  const assetValues = {};
  const offerDescriptors = {};
  for (const row of offerRows) {
    assetValues[row.asset.asset_id] = row.value_usd;
    offerDescriptors[row.asset.asset_id] = row.descriptor;
  }

  return {
    intent: {
      id: `market_listing_${listing.listing_id}`,
      status: 'active',
      actor: clone(listing.owner_actor),
      offer,
      want_spec: wantSpec,
      value_band: null,
      trust_constraints: { max_cycle_length: 6 },
      time_constraints: { expires_at: listing.expires_at ?? null }
    },
    meta: {
      ref: { kind: 'listing', id: listing.listing_id },
      title: listing.title,
      object_kind: listing.kind,
      owner_actor: clone(listing.owner_actor),
      offer_descriptors: offerDescriptors
    },
    assetValues
  };
}

function blueprintToIntent(blueprint) {
  if (!blueprint || blueprint.status !== 'published') return null;
  const offerRow = blueprintAsOfferAsset(blueprint);
  const offer = [offerRow.asset];
  const wantSpec = compensationWantSpecFromUsd(inferValueHintUsd(blueprint.valuation_hint) ?? 15);
  if (!wantSpec) return null;
  return {
    intent: {
      id: `market_blueprint_${blueprint.blueprint_id}`,
      status: 'active',
      actor: clone(blueprint.owner_actor),
      offer,
      want_spec: wantSpec,
      value_band: null,
      trust_constraints: { max_cycle_length: 6 },
      time_constraints: { expires_at: null }
    },
    meta: {
      ref: { kind: 'blueprint', id: blueprint.blueprint_id },
      title: blueprint.title,
      object_kind: 'blueprint',
      owner_actor: clone(blueprint.owner_actor),
      offer_descriptors: { [offerRow.asset.asset_id]: offerRow.descriptor }
    },
    assetValues: { [offerRow.asset.asset_id]: offerRow.value_usd }
  };
}

function marketEdgeToIntent(row, intentIdByRefKey) {
  if (!row || row.status === 'declined' || row.status === 'withdrawn' || row.status === 'expired') return null;
  const sourceKey = `${row.source_ref?.kind}:${row.source_ref?.id}`;
  const targetKey = `${row.target_ref?.kind}:${row.target_ref?.id}`;
  const sourceIntentId = intentIdByRefKey.get(sourceKey) ?? null;
  const targetIntentId = intentIdByRefKey.get(targetKey) ?? null;
  if (!sourceIntentId || !targetIntentId || sourceIntentId === targetIntentId) return null;
  if (row.edge_type === 'block') {
    return { source_intent_id: sourceIntentId, target_intent_id: targetIntentId, intent_type: 'block', status: 'active' };
  }
  if (row.edge_type === 'interest') {
    return { source_intent_id: sourceIntentId, target_intent_id: targetIntentId, intent_type: 'allow', status: 'active' };
  }
  if (row.edge_type === 'offer' || row.edge_type === 'counter') {
    return { source_intent_id: sourceIntentId, target_intent_id: targetIntentId, intent_type: 'prefer', status: 'active', strength: row.status === 'accepted' ? 1 : 0.7 };
  }
  return null;
}

function candidateStatusFromAcceptance(acceptanceState) {
  const states = Object.values(acceptanceState ?? {});
  if (states.some(value => value === 'rejected')) return 'rejected';
  if (states.length > 0 && states.every(value => value === 'accepted')) return 'accepted';
  if (states.some(value => value === 'accepted')) return 'awaiting_acceptance';
  return 'open';
}

function settlementTypeForLeg(legType) {
  if (legType === 'cash_payment') return 'cash';
  if (legType === 'credit_transfer') return 'credit';
  return 'barter';
}

function roleAssignmentsFromParticipants(participants) {
  return (participants ?? []).map((participant, index) => ({
    participant_key: actorProfileKey(participant.actor) ?? `participant_${index + 1}`,
    principal: clone(participant.actor),
    executor: clone(participant.actor),
    verifier: null,
    sponsor: null,
    broker: null,
    guarantor: null
  }));
}

function assetRefForLeg(leg) {
  return leg.asset ? clone(leg.asset) : null;
}

function blueprintRefForLeg(leg) {
  return leg.input_ref?.kind === 'blueprint' ? clone(leg.input_ref) : null;
}

function capabilityRefForLeg(leg) {
  return leg.leg_type === 'service_delivery' ? clone(leg.input_ref ?? null) : null;
}

function buildCandidateObligationGraph({ candidateId, candidateType, participants, legsPreview, acceptanceState }) {
  return {
    graph_id: `obl_${candidateId}`,
    graph_type: 'economic',
    candidate_type: candidateType,
    participant_roles: roleAssignmentsFromParticipants(participants),
    obligations: (legsPreview ?? []).map((leg, index) => ({
      obligation_id: leg.leg_id ?? `obligation_${index + 1}`,
      leg_id: leg.leg_id ?? `leg_${index + 1}`,
      from_principal: clone(leg.from_actor),
      to_principal: clone(leg.to_actor),
      leg_type: leg.leg_type,
      settlement_type: leg.settlement_type,
      asset_ref: assetRefForLeg(leg),
      blueprint_ref: blueprintRefForLeg(leg),
      capability_ref: capabilityRefForLeg(leg),
      valuation: { usd_amount: Number(leg.valuation_usd ?? 0) },
      blocking: leg.blocking !== false,
      depends_on_leg_ids: clone(leg.depends_on_leg_ids ?? []),
      acceptance_required_from: [actorProfileKey(leg.from_actor), actorProfileKey(leg.to_actor)].filter(Boolean)
    })),
    acceptance_state: clone(acceptanceState ?? {}),
    fallback_policy: {
      mode: candidateType === 'direct' ? 'expire_or_reprice' : 'recompute_or_expire',
      allows_substitution: false,
      unwind_required: false
    }
  };
}

function buildCandidateExecutionGraph({ candidateId, participants, legsPreview }) {
  return {
    graph_id: `exec_${candidateId}`,
    graph_type: 'execution_mapping',
    status: 'proposed',
    executors: roleAssignmentsFromParticipants(participants).map((assignment, index) => ({
      participant_key: assignment.participant_key,
      principal: assignment.principal,
      executor: assignment.executor,
      verifier: assignment.verifier,
      sponsor: assignment.sponsor,
      broker: assignment.broker,
      guarantor: assignment.guarantor,
      step_order: index + 1
    })),
    steps: (legsPreview ?? []).map((leg, index) => ({
      step_id: `step_${index + 1}`,
      leg_id: leg.leg_id ?? `leg_${index + 1}`,
      executor: clone(leg.from_actor),
      verifier: null,
      deliverable_type: leg.leg_type,
      blocking: leg.blocking !== false,
      depends_on_leg_ids: clone(leg.depends_on_leg_ids ?? [])
    }))
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function scoreCandidate({ proposal, candidateType, participants, legsPreview }) {
  const baseConfidence = clamp01(proposal.confidence_score ?? 0);
  const trustConfidence = clamp01((participants ?? []).every(row => row?.actor?.id && row?.actor?.type) ? 0.92 : 0.6);
  const verificationCost = (legsPreview ?? []).reduce((sum, leg) => {
    if (leg.leg_type === 'cash_payment' || leg.leg_type === 'access_grant') return sum + 0.18;
    if (leg.leg_type === 'blueprint_delivery' || leg.leg_type === 'service_delivery') return sum + 0.12;
    return sum + 0.06;
  }, 0);
  const participantCoordinationCost = Math.max(0, ((participants?.length ?? 0) - 2) * 0.08);
  const valueSpreadPenalty = Math.min(0.35, Math.max(0, Number(proposal.value_spread ?? 0) / 100));
  const completionProbability = clamp01(baseConfidence - verificationCost - participantCoordinationCost - valueSpreadPenalty + 0.25);
  const expectedSurplus = clamp01(1 - valueSpreadPenalty);
  const rawScore = (expectedSurplus * completionProbability * trustConfidence) - verificationCost;
  return {
    trust_confidence: trustConfidence,
    completion_probability: completionProbability,
    expected_surplus: expectedSurplus,
    verification_cost: Number(verificationCost.toFixed(3)),
    participant_coordination_cost: Number(participantCoordinationCost.toFixed(3)),
    value_spread_penalty: Number(valueSpreadPenalty.toFixed(3)),
    raw_score: Number(rawScore.toFixed(3))
  };
}

function clearingPolicyForCandidate({ candidateType, participants, maxCycleLength }) {
  if (candidateType === 'cycle' || (participants?.length ?? 0) > 2) {
    return {
      mode: 'batch_window',
      window_seconds: 60,
      max_cycle_length: maxCycleLength,
      commit_policy: 'all_participants_accept_before_materialization',
      selection_priority: 'feasibility_first'
    };
  }
  return {
    mode: 'continuous',
    window_seconds: 0,
    max_cycle_length: maxCycleLength,
    commit_policy: 'counterparty_accept_then_materialize',
    selection_priority: 'feasibility_first'
  };
}

function translateProposal({ proposal, metaByIntentId, existingCandidate = null, recordedAt, maxCycleLength }) {
  const participants = (proposal.participants ?? []).map((row, idx, all) => {
    const meta = metaByIntentId.get(row.intent_id) ?? null;
    return {
      actor: clone(row.actor),
      owner_profile: actorProfileSummary({ state: { market_actor_profiles: {} } }, row.actor),
      input_ref: meta?.ref ? clone(meta.ref) : null,
      gives_ref: meta?.ref ? clone(meta.ref) : null,
      receives_from_actor: clone(all[(idx + 1) % all.length]?.actor ?? null),
      title: meta?.title ?? null
    };
  });

  const legsPreview = (proposal.participants ?? []).map((row, idx, all) => {
    const meta = metaByIntentId.get(row.intent_id) ?? null;
    const toParticipant = all[(idx - 1 + all.length) % all.length];
    const firstAsset = Array.isArray(row.give) ? row.give[0] : null;
    const descriptor = meta?.offer_descriptors?.[firstAsset?.asset_id] ?? null;
    const legType = descriptor?.leg_type ?? 'asset_transfer';
    return {
      leg_id: `leg_${buildHash(`${proposal.id}:${row.intent_id}:${idx}`)}`,
      leg_type: legType,
      from_actor: clone(row.actor),
      to_actor: clone(toParticipant?.actor ?? null),
      input_ref: meta?.ref ? clone(meta.ref) : null,
      asset: firstAsset ? clone(firstAsset) : null,
      valuation_usd: Number(proposal.fee_breakdown?.[idx]?.fee_usd ?? 0) > 0 && legType === 'cash_payment'
        ? Number(proposal.fee_breakdown[idx].fee_usd * 100)
        : Number(firstAsset?.estimated_value_usd ?? 0),
      settlement_type: settlementTypeForLeg(legType),
      blocking: true
    };
  });

  const inputRefs = Array.from(new Map((proposal.participants ?? []).map(row => {
    const meta = metaByIntentId.get(row.intent_id) ?? null;
    const ref = meta?.ref ? clone(meta.ref) : null;
    return [ref ? `${ref.kind}:${ref.id}` : `${row.intent_id}`, ref];
  })).values()).filter(Boolean);

  const acceptanceState = clone(existingCandidate?.acceptance_state ?? {});
  for (const row of proposal.participants ?? []) {
    const actorKey = actorProfileKey(row.actor);
    if (!acceptanceState[actorKey]) acceptanceState[actorKey] = 'pending';
  }

  const hasMoneyLikeLeg = legsPreview.some(leg => leg.leg_type === 'cash_payment' || leg.leg_type === 'credit_transfer');
  const candidateType = hasMoneyLikeLeg ? 'mixed' : (proposal.participants?.length ?? 0) === 2 ? 'direct' : 'cycle';
  const candidateId = makeCandidateId(proposal.id);
  const status = candidateStatusFromAcceptance(acceptanceState);
  const scoreBreakdown = scoreCandidate({ proposal, candidateType, participants, legsPreview });
  const clearingPolicy = clearingPolicyForCandidate({ candidateType, participants, maxCycleLength });
  const obligationGraph = buildCandidateObligationGraph({
    candidateId,
    candidateType,
    participants,
    legsPreview,
    acceptanceState
  });
  const executionGraph = buildCandidateExecutionGraph({
    candidateId,
    participants,
    legsPreview
  });

  return {
    candidate_id: candidateId,
    workspace_id: (inputRefs[0]?.kind === 'listing'
      ? null
      : null),
    candidate_type: candidateType,
    status,
    participants,
    input_refs: inputRefs,
    legs_preview: legsPreview,
    valuation_summary: {
      confidence_score: Number(proposal.confidence_score ?? 0),
      value_spread: Number(proposal.value_spread ?? 0),
      fee_breakdown: clone(proposal.fee_breakdown ?? []),
      feasibility_priority: 'expected_surplus_x_completion_probability_x_trust_confidence'
    },
    settlement_summary: {
      mode: hasMoneyLikeLeg ? 'mixed' : 'barter',
      includes_cash: legsPreview.some(leg => leg.leg_type === 'cash_payment'),
      includes_credits: legsPreview.some(leg => leg.leg_type === 'credit_transfer')
    },
    score: clamp01(scoreBreakdown.raw_score),
    score_breakdown: scoreBreakdown,
    clearing_policy: clearingPolicy,
    explanation: [
      ...(Array.isArray(proposal.explainability) ? clone(proposal.explainability) : []),
      `clearing_mode=${clearingPolicy.mode}`,
      `completion_probability=${scoreBreakdown.completion_probability}`,
      `trust_confidence=${scoreBreakdown.trust_confidence}`
    ],
    legacy_refs: {
      proposal_id: proposal.id,
      matcher_engine: 'legacy_runMatching'
    },
    obligation_graph: obligationGraph,
    execution_graph: executionGraph,
    acceptance_state: acceptanceState,
    expires_at: normalizeProposalExpiresAt(proposal.expires_at),
    created_at: existingCandidate?.created_at ?? recordedAt,
    updated_at: recordedAt
  };
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
      return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid cursor format', details: { reason_code: 'market_feed_query_invalid', cursor_after: cursorAfter } };
    }
    if (decoded) {
      const idx = rows.findIndex(row => {
        const key = keyFn(row);
        return key.length === decoded.length && key.every((v, i) => String(v) === String(decoded[i]));
      });
      if (idx < 0) {
        return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'cursor not found', details: { reason_code: 'market_cursor_not_found', cursor_after: cursorAfter } };
      }
      start = idx + 1;
    }
  }
  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(keyFn(page[page.length - 1])) : null;
  return { ok: true, value: { page, total: rows.length, nextCursor } };
}

function normalizeListQuery(query) {
  const allowed = new Set(['workspace_id', 'status', 'candidate_type', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid query parameter', details: { reason_code: 'market_feed_query_invalid', key } };
  }
  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const status = normalizeOptionalString(query?.status)?.toLowerCase() ?? null;
  const candidateType = normalizeOptionalString(query?.candidate_type)?.toLowerCase() ?? null;
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);
  if (status && !CANDIDATE_STATUS.has(status)) return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid candidate status filter', details: { reason_code: 'market_candidate_invalid', status } };
  if (candidateType && !CANDIDATE_TYPES.has(candidateType)) return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid candidate type filter', details: { reason_code: 'market_candidate_invalid', candidate_type: candidateType } };
  if (limit === null) return { ok: false, code: 'CONSTRAINT_VIOLATION', message: 'invalid limit', details: { reason_code: 'market_feed_query_invalid', limit: query?.limit } };
  return { ok: true, value: { workspace_id: workspaceId, status, candidate_type: candidateType, limit, cursor_after: cursorAfter } };
}

export class MarketCandidateService {
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
    return resolveSubjectActor({ actor, auth });
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === requestHash) {
        return { replayed: true, result: clone(existing.result) };
      }
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', { operation_id: operationId, idempotency_key: idempotencyKey }) } };
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

  _computeWorkspaceCandidates({ workspaceId, recordedAt, maxCycleLength = 4, maxCandidates = 50 }) {
    const intents = [];
    const metaByIntentId = new Map();
    const assetValuesUsd = {};
    const intentIdByRefKey = new Map();

    for (const listing of Object.values(this.store.state.market_listings ?? {})) {
      if (!listing || listing.workspace_id !== workspaceId || listing.status !== 'open') continue;
      const compiled = listingToIntent(listing);
      if (!compiled) continue;
      intents.push(compiled.intent);
      metaByIntentId.set(compiled.intent.id, compiled.meta);
      intentIdByRefKey.set(`${compiled.meta.ref.kind}:${compiled.meta.ref.id}`, compiled.intent.id);
      Object.assign(assetValuesUsd, compiled.assetValues);
    }

    for (const blueprint of Object.values(this.store.state.market_blueprints ?? {})) {
      if (!blueprint || blueprint.workspace_id !== workspaceId || blueprint.status !== 'published') continue;
      const compiled = blueprintToIntent(blueprint);
      if (!compiled) continue;
      intents.push(compiled.intent);
      metaByIntentId.set(compiled.intent.id, compiled.meta);
      intentIdByRefKey.set(`${compiled.meta.ref.kind}:${compiled.meta.ref.id}`, compiled.intent.id);
      Object.assign(assetValuesUsd, compiled.assetValues);
    }

    const edgeIntents = Object.values(this.store.state.market_edges ?? {})
      .filter(edge => edge.workspace_id === workspaceId)
      .map(edge => marketEdgeToIntent(edge, intentIdByRefKey))
      .filter(Boolean);

    const matching = runMatching({
      intents,
      assetValuesUsd,
      edgeIntents,
      nowIso: recordedAt,
      minCycleLength: 2,
      maxCycleLength,
      includeCycleDiagnostics: false
    });

    const translated = (matching.proposals ?? []).slice(0, maxCandidates).map(proposal => translateProposal({
      proposal,
      metaByIntentId,
      existingCandidate: this.store.state.market_candidates?.[makeCandidateId(proposal.id)] ?? null,
      recordedAt,
      maxCycleLength
    }));
    translated.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.candidate_id).localeCompare(String(b.candidate_id));
    });

    for (const row of translated) {
      row.workspace_id = workspaceId;
      this.store.state.market_candidates[row.candidate_id] = row;
    }
    return translated;
  }

  compute({ actor, auth, idempotencyKey, request }) {
    const op = 'marketCandidates.compute';
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
        const workspaceId = normalizeOptionalString(request?.workspace_id);
        const recordedAt = normalizeRecordedAt(request, auth);
        const maxCycleLength = Number.parseInt(String(request?.max_cycle_length ?? 4), 10);
        const maxCandidates = Number.parseInt(String(request?.max_candidates ?? 25), 10);
        if (!workspaceId || parseIsoMs(recordedAt) === null || !Number.isFinite(maxCycleLength) || maxCycleLength < 2 || !Number.isFinite(maxCandidates) || maxCandidates < 1) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid candidate compute request', { reason_code: 'market_candidate_invalid' }) };
        }
        const candidates = this._computeWorkspaceCandidates({ workspaceId, recordedAt, maxCycleLength: Math.min(maxCycleLength, 6), maxCandidates: Math.min(maxCandidates, 100) });
        return { ok: true, body: { correlation_id: corr, candidates, total: candidates.length, next_cursor: null } };
      }
    });
  }

  get({ actor, auth, candidateId }) {
    const op = 'marketCandidates.get';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };
    const load = this._loadCandidateOrError({ candidateId, correlationId: corr });
    if (!load.ok) return load;
    const record = load.record;
    const subjectActor = this._subjectActor({ actor, auth });
    const isPublic = publicVisibleCandidate(this.store, record);
    const isParticipant = Array.isArray(record.participants) && record.participants.some(row => actorEquals(row.actor, subjectActor));
    if (!isPublic && !isParticipant) {
      return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'candidate not found', { reason_code: 'market_candidate_not_found', candidate_id: candidateId }) };
    }
    return { ok: true, body: { correlation_id: corr, candidate: clone(record) } };
  }

  list({ actor, auth, query }) {
    const op = 'marketCandidates.list';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };
    const normalized = normalizeListQuery(query ?? {});
    if (!normalized.ok) return { ok: false, body: errorResponse(corr, normalized.code, normalized.message, normalized.details) };
    const subjectActor = this._subjectActor({ actor, auth });
    const rows = Object.values(this.store.state.market_candidates ?? {}).filter(record => {
      if (!record) return false;
      if (normalized.value.workspace_id && record.workspace_id !== normalized.value.workspace_id) return false;
      if (normalized.value.status && record.status !== normalized.value.status) return false;
      if (normalized.value.candidate_type && record.candidate_type !== normalized.value.candidate_type) return false;
      const isPublic = publicVisibleCandidate(this.store, record);
      const isParticipant = Array.isArray(record.participants) && record.participants.some(row => actorEquals(row.actor, subjectActor));
      if (!isPublic && !isParticipant) return false;
      return true;
    }).map(record => clone(record));
    sortByUpdatedDescThenId(rows, 'candidate_id');
    const page = buildPaginationSlice({ rows, limit: normalized.value.limit, cursorAfter: normalized.value.cursor_after, keyFn: row => [row.updated_at, row.candidate_id], cursorParts: 2 });
    if (!page.ok) return { ok: false, body: errorResponse(corr, page.code, page.message, page.details) };
    return { ok: true, body: { correlation_id: corr, candidates: page.value.page, total: page.value.total, next_cursor: page.value.nextCursor } };
  }

  _transition({ actor, auth, candidateId, idempotencyKey, request, operationId, targetState }) {
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
        const load = this._loadCandidateOrError({ candidateId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const record = load.record;
        const subjectActor = this._subjectActor({ actor, auth });
        const participant = (record.participants ?? []).find(row => actorEquals(row.actor, subjectActor));
        if (!participant) {
          return { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'candidate participant actor required', { reason_code: 'market_candidate_forbidden', candidate_id: candidateId, actor: subjectActor }) };
        }
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid candidate timestamp', { reason_code: 'market_candidate_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        if (record.expires_at && (parseIsoMs(record.expires_at) ?? 0) < (parseIsoMs(recordedAt) ?? 0)) {
          record.status = 'expired';
          record.updated_at = recordedAt;
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'candidate has expired', { reason_code: 'market_candidate_invalid', candidate_id: candidateId, expires_at: record.expires_at }) };
        }
        record.acceptance_state ||= {};
        record.acceptance_state[actorProfileKey(subjectActor)] = targetState;
        record.status = candidateStatusFromAcceptance(record.acceptance_state);
        record.updated_at = recordedAt;
        return { ok: true, body: { correlation_id: corr, candidate: clone(record) } };
      }
    });
  }

  accept({ actor, auth, candidateId, idempotencyKey, request }) {
    return this._transition({ actor, auth, candidateId, idempotencyKey, request, operationId: 'marketCandidates.accept', targetState: 'accepted' });
  }

  reject({ actor, auth, candidateId, idempotencyKey, request }) {
    return this._transition({ actor, auth, candidateId, idempotencyKey, request, operationId: 'marketCandidates.reject', targetState: 'rejected' });
  }

  refresh({ actor, auth, candidateId, idempotencyKey, request }) {
    const op = 'marketCandidates.refresh';
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
        const load = this._loadCandidateOrError({ candidateId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };
        const record = load.record;
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid candidate timestamp', { reason_code: 'market_candidate_invalid', recorded_at: request?.recorded_at ?? null }) };
        }
        const refreshed = this._computeWorkspaceCandidates({ workspaceId: record.workspace_id, recordedAt, maxCycleLength: 4, maxCandidates: 100 });
        const updated = refreshed.find(row => row.candidate_id === candidateId) ?? null;
        if (!updated) {
          record.status = 'superseded';
          record.updated_at = recordedAt;
          return { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'candidate not found after refresh', { reason_code: 'market_candidate_not_found', candidate_id: candidateId }) };
        }
        updated.acceptance_state = clone(record.acceptance_state ?? updated.acceptance_state ?? {});
        updated.status = candidateStatusFromAcceptance(updated.acceptance_state);
        updated.updated_at = recordedAt;
        this.store.state.market_candidates[candidateId] = updated;
        return { ok: true, body: { correlation_id: corr, candidate: clone(updated) } };
      }
    });
  }
}
