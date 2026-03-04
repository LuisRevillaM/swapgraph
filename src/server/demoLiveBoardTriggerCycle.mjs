function trimOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function token() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function isoPlusMinutes(iso, minutes) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return new Date(Date.now() + (minutes * 60 * 1000)).toISOString();
  return new Date(ms + (minutes * 60 * 1000)).toISOString();
}

function resultBodyOrThrow(step, out) {
  const result = out?.result ?? out;
  if (result?.ok) return result.body ?? {};
  const error = result?.body?.error ?? {};
  const code = trimOrNull(error.code) ?? 'UNKNOWN';
  const message = trimOrNull(error.message) ?? `${step} failed`;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  throw new Error(`${step} failed (${code}): ${message}${Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : ''}`);
}

function intentPayload({ intentId, actorId, offerAssetId, wantAssetId, valueUsd, nowIso }) {
  const titleActor = actorId === 'architects_dream' ? 'Architects Dream' : actorId;
  return {
    intent: {
      id: intentId,
      actor: { type: 'user', id: actorId },
      offer: [{
        platform: 'steam',
        app_id: 730,
        context_id: 2,
        asset_id: offerAssetId,
        class_id: `class_${offerAssetId}`,
        instance_id: '0',
        metadata: {
          demo_kind: 'creative_labor_asset',
          reality_mode: 'simulated',
          deliverable_type: 'image_banner',
          title: `Demo output for ${titleActor}`,
          prompt_spec: `Cinematic architectural concept board by ${actorId}`,
          delivery_target_options: [
            'discord:channel:1468821039050915988',
            'discord:channel:1476417618104680639'
          ],
          list_price_usd: valueUsd,
          value_usd: valueUsd,
          preview_image_url: `https://picsum.photos/seed/${encodeURIComponent(offerAssetId)}/1024/768`
        },
        proof: {
          inventory_snapshot_id: `snap_${offerAssetId}`,
          verified_at: nowIso
        }
      }],
      want_spec: {
        type: 'set',
        any_of: [{
          type: 'specific_asset',
          platform: 'steam',
          asset_key: `steam:${wantAssetId}`
        }]
      },
      value_band: {
        min_usd: Math.max(1, valueUsd - 30),
        max_usd: valueUsd + 30,
        pricing_source: 'market_median'
      },
      trust_constraints: {
        max_cycle_length: 4,
        min_counterparty_reliability: 0
      },
      time_constraints: {
        expires_at: isoPlusMinutes(nowIso, 90),
        urgency: 'normal'
      },
      settlement_preferences: {
        require_escrow: true
      }
    }
  };
}

function actorAuth(scopes) {
  return { scopes: Array.from(new Set(scopes.filter(Boolean))) };
}

function containsAll(haystackSet, requiredValues) {
  for (const value of requiredValues) {
    if (!haystackSet.has(value)) return false;
  }
  return true;
}

export function runDemoLiveBoardTriggerCycle({
  swapIntents,
  marketplaceMatching,
  proposalsRead,
  commitsApi,
  settlementWrite
}) {
  const runNonce = token();
  const nowIso = new Date().toISOString();

  const actors = [
    { type: 'user', id: 'workshop', value_usd: 145 },
    { type: 'user', id: 'architects_dream', value_usd: 151 },
    { type: 'user', id: 'cto', value_usd: 149 },
    { type: 'user', id: 'toxins', value_usd: 147 }
  ];
  const actorById = new Map(actors.map(actor => [actor.id, actor]));
  const partner = { type: 'partner', id: 'marketplace' };

  const ringWants = new Map([
    ['workshop', 'architects_dream'],
    ['architects_dream', 'workshop'],
    ['cto', 'toxins'],
    ['toxins', 'cto']
  ]);

  const createdIntentRows = [];
  const assetValueMap = {};
  const intentByActorId = {};
  const assetByActorId = {};

  const userWriteAuth = actorAuth(['swap_intents:write', 'commits:write', 'settlement:write']);
  const partnerWriteAuth = actorAuth(['settlement:write', 'cycle_proposals:read', 'settlement:read', 'receipts:read']);
  const partnerReadAuth = actorAuth(['cycle_proposals:read', 'settlement:read', 'receipts:read']);

  for (const actor of actors) {
    const intentId = `demo_intent_${actor.id}_${runNonce}`;
    const offerAssetId = `demo_asset_${actor.id}_${runNonce}`;
    const wantActorId = ringWants.get(actor.id);
    const wantAssetId = `demo_asset_${wantActorId}_${runNonce}`;

    resultBodyOrThrow(`swap-intents.create.${actor.id}`, swapIntents.create({
      actor,
      auth: userWriteAuth,
      idempotencyKey: `demo-live-intent-${actor.id}-${runNonce}`,
      requestBody: intentPayload({
        intentId,
        actorId: actor.id,
        offerAssetId,
        wantAssetId,
        valueUsd: actor.value_usd,
        nowIso
      })
    }));

    intentByActorId[actor.id] = intentId;
    assetByActorId[actor.id] = offerAssetId;
    assetValueMap[offerAssetId] = actor.value_usd;
    createdIntentRows.push({
      actor_id: actor.id,
      intent_id: intentId,
      asset_id: offerAssetId
    });
  }

  const requiredGroups = [
    new Set([intentByActorId.workshop, intentByActorId.architects_dream]),
    new Set([intentByActorId.cto, intentByActorId.toxins])
  ];
  const selectedProposalByGroup = [null, null];
  const selectedProposalById = new Map();
  let selectedRunId = null;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const runBody = resultBodyOrThrow(`marketplace.matching.run.${attempt}`, marketplaceMatching.runMatching({
      actor: partner,
      auth: partnerWriteAuth,
      idempotencyKey: `demo-live-match-${runNonce}-${attempt}`,
      request: {
        replace_existing: true,
        max_proposals: 200,
        asset_values_usd: assetValueMap
      }
    }));

    const runId = trimOrNull(runBody?.run?.run_id);
    if (runId) selectedRunId = runId;
    const proposalIds = Array.isArray(runBody?.run?.proposal_ids)
      ? runBody.run.proposal_ids.filter(x => typeof x === 'string' && x.trim())
      : [];

    for (const proposalId of proposalIds) {
      const proposalBody = resultBodyOrThrow(`cycle-proposals.get.${proposalId}`, proposalsRead.get({
        actor: partner,
        auth: partnerReadAuth,
        proposalId
      }));

      const participants = Array.isArray(proposalBody?.proposal?.participants)
        ? proposalBody.proposal.participants
        : [];
      const actorIds = participants.map(p => trimOrNull(p?.actor?.id)).filter(Boolean);
      if (actorIds.some(actorId => !actorById.has(actorId))) continue;

      const intentIds = new Set(participants.map(p => trimOrNull(p?.intent_id)).filter(Boolean));
      let matchedAny = false;
      for (let idx = 0; idx < requiredGroups.length; idx += 1) {
        if (selectedProposalByGroup[idx]) continue;
        if (containsAll(intentIds, requiredGroups[idx])) {
          selectedProposalByGroup[idx] = proposalId;
          matchedAny = true;
        }
      }

      if (matchedAny || !selectedProposalById.has(proposalId)) {
        selectedProposalById.set(proposalId, proposalBody.proposal);
      }
    }

    if (selectedProposalByGroup.every(Boolean)) break;
  }

  if (!selectedProposalByGroup.every(Boolean)) {
    throw new Error('matching did not produce both required group cycles (workshop<->architects_dream and cto<->toxins)');
  }

  const uniqueProposalIds = Array.from(new Set(selectedProposalByGroup.filter(Boolean)));
  const settledCycles = [];

  for (const proposalId of uniqueProposalIds) {
    let proposal = selectedProposalById.get(proposalId) ?? null;
    if (!proposal) {
      const proposalBody = resultBodyOrThrow(`cycle-proposals.get.missing.${proposalId}`, proposalsRead.get({
        actor: partner,
        auth: partnerReadAuth,
        proposalId
      }));
      proposal = proposalBody?.proposal ?? null;
    }
    if (!proposal) throw new Error(`proposal missing after selection: ${proposalId}`);

    const participants = Array.isArray(proposal?.participants) ? proposal.participants : [];
    for (const participant of participants) {
      const actorId = trimOrNull(participant?.actor?.id);
      const actor = actorId ? actorById.get(actorId) ?? null : null;
      if (!actor) throw new Error(`unknown actor in selected proposal ${proposalId}: ${actorId ?? 'null'}`);
      resultBodyOrThrow(`cycle-proposals.accept.${actor.id}`, commitsApi.accept({
        actor,
        auth: userWriteAuth,
        idempotencyKey: `demo-live-accept-${actor.id}-${runNonce}-${proposalId}`,
        proposalId,
        requestBody: { proposal_id: proposalId },
        occurredAt: new Date().toISOString()
      }));
    }

    resultBodyOrThrow(`settlement.start.${proposalId}`, settlementWrite.start({
      actor: partner,
      auth: partnerWriteAuth,
      cycleId: proposalId,
      requestBody: { deposit_deadline_at: isoPlusMinutes(new Date().toISOString(), 30) },
      occurredAt: new Date().toISOString()
    }));

    for (const participant of participants) {
      const actorId = trimOrNull(participant?.actor?.id);
      const actor = actorId ? actorById.get(actorId) ?? null : null;
      if (!actor) continue;
      resultBodyOrThrow(`settlement.deposit_confirmed.${actor.id}`, settlementWrite.depositConfirmed({
        actor,
        auth: userWriteAuth,
        cycleId: proposalId,
        requestBody: { deposit_ref: `dep_${actor.id}_${runNonce}_${proposalId}` },
        occurredAt: new Date().toISOString()
      }));
    }

    resultBodyOrThrow(`settlement.begin_execution.${proposalId}`, settlementWrite.beginExecution({
      actor: partner,
      auth: partnerWriteAuth,
      cycleId: proposalId,
      requestBody: {},
      occurredAt: new Date().toISOString()
    }));

    const completeBody = resultBodyOrThrow(`settlement.complete.${proposalId}`, settlementWrite.complete({
      actor: partner,
      auth: partnerWriteAuth,
      cycleId: proposalId,
      requestBody: {},
      occurredAt: new Date().toISOString()
    }));

    settledCycles.push({
      proposal_id: proposalId,
      participant_actor_ids: participants.map(row => trimOrNull(row?.actor?.id)).filter(Boolean),
      receipt_id: trimOrNull(completeBody?.receipt?.id),
      final_state: trimOrNull(completeBody?.receipt?.final_state) ?? trimOrNull(completeBody?.timeline?.state)
    });
  }

  return {
    scenario: 'four_workspace_demo_cycle',
    run_nonce: runNonce,
    matching_run_id: selectedRunId,
    actors: actors.map(actor => actor.id),
    created_intents: createdIntentRows,
    settled_cycles: settledCycles,
    cycle_count: settledCycles.length,
    proposal_id: settledCycles[0]?.proposal_id ?? null,
    receipt_id: settledCycles[0]?.receipt_id ?? null,
    final_state: settledCycles.every(row => row.final_state === 'completed') ? 'completed' : 'mixed'
  };
}
