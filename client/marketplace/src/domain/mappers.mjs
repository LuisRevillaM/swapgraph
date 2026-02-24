import {
  asBoolean,
  asIsoDate,
  asNumber,
  asString,
  ensureArray,
  normalizeActorRef
} from './models.mjs';

export function mapAssetRef(asset) {
  const metadata = asset?.metadata ?? {};
  const valueUsd = asNumber(metadata?.value_usd, asNumber(metadata?.valueUsd, 0));
  return {
    platform: asString(asset?.platform, 'steam'),
    appId: asNumber(asset?.app_id, 730),
    contextId: asNumber(asset?.context_id, 2),
    assetId: asString(asset?.asset_id, ''),
    classId: asString(asset?.class_id, ''),
    instanceId: asString(asset?.instance_id, ''),
    valueUsd,
    wear: asString(metadata?.wear, ''),
    floatValue: asNumber(metadata?.float_value, asNumber(metadata?.floatValue, 0)),
    label: asString(metadata?.label, '')
  };
}

export function mapIntentDto(intent) {
  return {
    id: asString(intent?.id, ''),
    status: asString(intent?.status, 'active'),
    actor: normalizeActorRef(intent?.actor, 'user', 'unknown'),
    offer: ensureArray(intent?.offer).map(mapAssetRef),
    wantSpec: intent?.want_spec ?? null,
    valueBand: {
      minUsd: asNumber(intent?.value_band?.min_usd, 0),
      maxUsd: asNumber(intent?.value_band?.max_usd, 0),
      pricingSource: asString(intent?.value_band?.pricing_source, '')
    },
    trustConstraints: {
      maxCycleLength: asNumber(intent?.trust_constraints?.max_cycle_length, 0),
      minCounterpartyReliability: asNumber(intent?.trust_constraints?.min_counterparty_reliability, 0)
    },
    timeConstraints: {
      expiresAt: asIsoDate(intent?.time_constraints?.expires_at, null),
      urgency: asString(intent?.time_constraints?.urgency, 'normal')
    },
    settlementPreferences: {
      requireEscrow: asBoolean(intent?.settlement_preferences?.require_escrow, false)
    }
  };
}

function mapProposalParticipant(participant) {
  return {
    intentId: asString(participant?.intent_id, ''),
    actor: normalizeActorRef(participant?.actor, 'user', 'unknown'),
    give: ensureArray(participant?.give).map(mapAssetRef),
    get: ensureArray(participant?.get).map(mapAssetRef)
  };
}

export function mapProposalDto(proposal) {
  return {
    id: asString(proposal?.id, ''),
    expiresAt: asIsoDate(proposal?.expires_at, null),
    participants: ensureArray(proposal?.participants).map(mapProposalParticipant),
    confidenceScore: asNumber(proposal?.confidence_score, 0),
    valueSpread: asNumber(proposal?.value_spread, 0),
    explainability: ensureArray(proposal?.explainability).map(x => asString(x, '')).filter(Boolean)
  };
}

export function mapMatchingRunDto(run) {
  return {
    runId: asString(run?.run_id, ''),
    requestedBy: normalizeActorRef(run?.requested_by, 'partner', 'unknown'),
    recordedAt: asIsoDate(run?.recorded_at, null),
    replaceExisting: asBoolean(run?.replace_existing, true),
    maxProposals: asNumber(run?.max_proposals, 0),
    activeIntentsCount: asNumber(run?.active_intents_count, 0),
    selectedProposalsCount: asNumber(run?.selected_proposals_count, 0),
    storedProposalsCount: asNumber(run?.stored_proposals_count, 0),
    replacedProposalsCount: asNumber(run?.replaced_proposals_count, 0),
    expiredProposalsCount: asNumber(run?.expired_proposals_count, 0),
    proposalIds: ensureArray(run?.proposal_ids).map(id => asString(id, '')).filter(Boolean),
    stats: {
      candidateCycles: asNumber(run?.stats?.candidate_cycles, 0),
      candidateProposals: asNumber(run?.stats?.candidate_proposals, 0),
      acceptedCycles: asNumber(run?.stats?.accepted_cycles, 0),
      rejectedValueBand: asNumber(run?.stats?.rejected_value_band, 0),
      rejectedTrustPolicy: asNumber(run?.stats?.rejected_trust_policy, 0),
      rejectedLiquidityPolicy: asNumber(run?.stats?.rejected_liquidity_policy, 0),
      rejectedCycleLength: asNumber(run?.stats?.rejected_cycle_length, 0),
      rejectedMissingAssetValue: asNumber(run?.stats?.rejected_missing_asset_value, 0),
      replacedExisting: asNumber(run?.stats?.replaced_existing, 0),
      expiredExisting: asNumber(run?.stats?.expired_existing, 0)
    }
  };
}

function mapTimelineLeg(leg) {
  return {
    legId: asString(leg?.leg_id, ''),
    intentId: asString(leg?.intent_id, ''),
    fromActor: normalizeActorRef(leg?.from_actor, 'user', 'unknown'),
    toActor: normalizeActorRef(leg?.to_actor, 'user', 'unknown'),
    assets: ensureArray(leg?.assets).map(mapAssetRef),
    status: asString(leg?.status, 'pending'),
    depositDeadlineAt: asIsoDate(leg?.deposit_deadline_at, null),
    depositMode: asString(leg?.deposit_mode, 'deposit')
  };
}

export function mapTimelineDto(timeline) {
  return {
    cycleId: asString(timeline?.cycle_id, ''),
    state: asString(timeline?.state, 'proposed'),
    updatedAt: asIsoDate(timeline?.updated_at, null),
    legs: ensureArray(timeline?.legs).map(mapTimelineLeg)
  };
}

function mapReceiptFee(fee) {
  return {
    actor: normalizeActorRef(fee?.actor, 'user', 'unknown'),
    feeUsd: asNumber(fee?.fee_usd, 0)
  };
}

function mapLiquidityProvider(provider) {
  return {
    providerId: asString(provider?.provider_id, ''),
    providerType: asString(provider?.provider_type, ''),
    ownerActor: normalizeActorRef(provider?.owner_actor, 'user', 'unknown'),
    isAutomated: asBoolean(provider?.is_automated, false),
    isHouseInventory: asBoolean(provider?.is_house_inventory, false),
    labelRequired: asBoolean(provider?.label_required, false),
    displayLabel: asString(provider?.display_label, ''),
    disclosureText: asString(provider?.disclosure_text, ''),
    active: asBoolean(provider?.active, false),
    createdAt: asIsoDate(provider?.created_at, null),
    updatedAt: asIsoDate(provider?.updated_at, null)
  };
}

function mapLiquiditySummaryRow(row) {
  return {
    provider: mapLiquidityProvider(row?.provider),
    participantCount: Math.max(0, Math.trunc(asNumber(row?.participant_count, 0))),
    counterpartyIntentIds: ensureArray(row?.counterparty_intent_ids).map(id => asString(id, '')).filter(Boolean)
  };
}

function cloneObjectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

export function mapReceiptDto(receipt) {
  const transparency = cloneObjectRecord(receipt?.transparency);
  if (Object.prototype.hasOwnProperty.call(transparency, 'reason_code')
    && !Object.prototype.hasOwnProperty.call(transparency, 'reasonCode')) {
    transparency.reasonCode = transparency.reason_code;
  }

  return {
    id: asString(receipt?.id, ''),
    cycleId: asString(receipt?.cycle_id, ''),
    finalState: asString(receipt?.final_state, 'failed'),
    createdAt: asIsoDate(receipt?.created_at, null),
    intentIds: ensureArray(receipt?.intent_ids).map(id => asString(id, '')).filter(Boolean),
    assetIds: ensureArray(receipt?.asset_ids).map(id => asString(id, '')).filter(Boolean),
    fees: ensureArray(receipt?.fees).map(mapReceiptFee),
    liquidityProviderSummary: ensureArray(receipt?.liquidity_provider_summary).map(mapLiquiditySummaryRow),
    signature: {
      keyId: asString(receipt?.signature?.key_id, ''),
      algorithm: asString(receipt?.signature?.alg, ''),
      signature: asString(receipt?.signature?.sig, '')
    },
    transparency
  };
}

export function mapErrorEnvelope(errorBody, status = 500) {
  const code = asString(errorBody?.error?.code, 'INTERNAL');
  const message = asString(errorBody?.error?.message, 'request failed');
  return {
    status,
    code,
    message,
    details: errorBody?.error?.details ?? {}
  };
}

export function mapIntentListResponse(body) {
  return ensureArray(body?.intents).map(mapIntentDto);
}

export function mapProposalListResponse(body) {
  return ensureArray(body?.proposals).map(mapProposalDto);
}

export function mapInventoryAwakeningProjection(body) {
  const projection = body?.projection ?? {};
  const summary = projection?.swappability_summary ?? {};
  const recommendations = ensureArray(projection?.recommended_first_intents).map(row => ({
    recommendationId: asString(row?.recommendation_id, ''),
    cycleId: asString(row?.cycle_id, ''),
    suggestedGiveAssetId: asString(row?.suggested_give_asset_id, ''),
    suggestedGetAssetId: asString(row?.suggested_get_asset_id, ''),
    confidenceBps: asNumber(row?.confidence_bps, 0),
    rationale: asString(row?.rationale, '')
  }));

  return {
    swappabilitySummary: {
      intentsTotal: asNumber(summary?.intents_total, 0),
      activeIntents: asNumber(summary?.active_intents, 0),
      cycleOpportunities: asNumber(summary?.cycle_opportunities, 0),
      averageConfidenceBps: asNumber(summary?.average_confidence_bps, 0)
    },
    recommendedFirstIntents: recommendations
  };
}
