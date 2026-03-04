function trimOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function token() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function randomIntInclusive(min, max) {
  const low = Number.isFinite(min) ? Math.floor(min) : 0;
  const high = Number.isFinite(max) ? Math.floor(max) : low;
  if (high <= low) return low;
  return low + Math.floor(Math.random() * ((high - low) + 1));
}

function randomPick(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = randomIntInclusive(0, list.length - 1);
  return list[idx] ?? null;
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

function actorDisplayName(actorId) {
  if (actorId === 'architects_dream') return 'Architects Dream';
  if (actorId === 'cto') return 'CTO';
  return actorId;
}

function intentPayload({
  intentId,
  actorId,
  offerAssetId,
  wantAssetIds,
  valueUsd,
  nowIso,
  styleHint,
  styleTags = [],
  intentMessage = null,
  deliveryCapabilityToken = null
}) {
  const titleActor = actorDisplayName(actorId);
  const wantedAssets = Array.isArray(wantAssetIds) ? wantAssetIds.filter(x => typeof x === 'string' && x.trim()) : [];
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
          prompt_spec: `${styleHint} by ${titleActor}`,
          intent_message: intentMessage,
          style_tags: styleTags,
          delivery_target_options: [
            'discord:channel:1468821039050915988',
            'discord:channel:1476417618104680639'
          ],
          delivery_capability_token: deliveryCapabilityToken,
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
        any_of: wantedAssets.map(wantAssetId => ({
          type: 'specific_asset',
          platform: 'steam',
          asset_key: `steam:${wantAssetId}`
        }))
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

function readProposalParticipants(proposal) {
  const participants = Array.isArray(proposal?.participants) ? proposal.participants : [];
  return {
    participants,
    actorIds: participants.map(row => trimOrNull(row?.actor?.id)).filter(Boolean),
    intentIds: participants.map(row => trimOrNull(row?.intent_id)).filter(Boolean)
  };
}

function selectDisjointWorkspaceProposals({ candidates, maxCycles = 2 }) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.actorIds.length !== a.actorIds.length) return b.actorIds.length - a.actorIds.length;
    if (b.intentIds.length !== a.intentIds.length) return b.intentIds.length - a.intentIds.length;
    return String(a.proposalId).localeCompare(String(b.proposalId));
  });
  const selected = [];
  const usedIntentIds = new Set();
  for (const row of sorted) {
    if (row.intentIds.some(intentId => usedIntentIds.has(intentId))) continue;
    selected.push(row);
    for (const intentId of row.intentIds) usedIntentIds.add(intentId);
    if (selected.length >= maxCycles) break;
  }
  return selected;
}

export function runDemoLiveBoardTriggerCycle({
  swapIntents,
  marketplaceMatching,
  proposalsRead,
  commitsApi,
  settlementWrite,
  mode = 'balanced'
}) {
  const runNonce = token();
  const nowIso = new Date().toISOString();
  const normalizedMode = trimOrNull(mode)?.toLowerCase() === 'multihop' ? 'multihop' : 'balanced';

  const actorTemplates = [
    {
      type: 'user',
      id: 'workshop',
      base_value_usd: 145,
      style_hint: 'Editorial collage for a workshop launch board',
      style_tags: ['editorial', 'grainy', 'zine', 'kinetic']
    },
    {
      type: 'user',
      id: 'architects_dream',
      base_value_usd: 151,
      style_hint: 'Cinematic architecture concept board with brutalist textures',
      style_tags: ['brutalist', 'cinematic', 'monumental', 'concrete']
    },
    {
      type: 'user',
      id: 'cto',
      base_value_usd: 149,
      style_hint: 'Technical product hero visual with blueprint overlays',
      style_tags: ['diagrammatic', 'blueprint', 'precision', 'futurist']
    },
    {
      type: 'user',
      id: 'toxins',
      base_value_usd: 147,
      style_hint: 'Experimental poster with bio-lab gradients and sharp typography',
      style_tags: ['bio-lab', 'acid', 'poster', 'experimental']
    }
  ];
  const actors = actorTemplates.map(template => ({
    type: template.type,
    id: template.id,
    style_hint: template.style_hint,
    style_tags: Array.isArray(template.style_tags) ? template.style_tags : [],
    value_usd: Math.max(50, template.base_value_usd + randomIntInclusive(-12, 12))
  }));
  const actorById = new Map(actors.map(actor => [actor.id, actor]));
  const partner = { type: 'partner', id: 'marketplace' };

  const createdIntentRows = [];
  const assetValueMap = {};
  const intentByActorId = Object.fromEntries(actors.map(actor => [actor.id, `demo_intent_${actor.id}_${runNonce}`]));
  const assetByActorId = Object.fromEntries(actors.map(actor => [actor.id, `demo_asset_${actor.id}_${runNonce}`]));
  const createdIntentIds = new Set(Object.values(intentByActorId));

  const userWriteAuth = actorAuth(['swap_intents:write', 'commits:write', 'settlement:write']);
  const partnerWriteAuth = actorAuth(['settlement:write', 'cycle_proposals:read', 'settlement:read', 'receipts:read']);
  const partnerReadAuth = actorAuth(['cycle_proposals:read', 'settlement:read', 'receipts:read']);

  for (const actor of actors) {
    const intentId = intentByActorId[actor.id];
    const offerAssetId = assetByActorId[actor.id];
    const actorIndex = actors.findIndex(row => row.id === actor.id);
    const wantActorIds = normalizedMode === 'multihop'
      ? [actors[(actorIndex + 1) % actors.length].id]
      : (() => {
        const ids = [];
        for (let offset = 1; offset < actors.length; offset += 1) {
          const idx = (actorIndex + offset) % actors.length;
          ids.push(actors[idx].id);
        }
        return ids;
      })();
    const wantAssetIds = wantActorIds.map(wantActorId => assetByActorId[wantActorId]).filter(Boolean);
    const styleTags = Array.isArray(actor.style_tags) ? actor.style_tags : [];
    const intentMessagePool = [
      `I want a result with stronger ${styleTags[0] ?? 'visual'} personality.`,
      `Seeking a weird but coherent exchange, not generic output.`,
      `I can deliver fast if I get a distinct style back.`,
      `Looking for high-signal art direction and unique composition.`
    ];
    const intentMessage = randomPick(intentMessagePool);
    const deliveryTarget = randomPick([
      'discord:channel:1468821039050915988',
      'discord:channel:1476417618104680639'
    ]);
    const deliveryCapabilityToken = {
      token_id: `cap_${actor.id}_${runNonce}`,
      issued_by: 'marketplace',
      delivery_target: deliveryTarget,
      scope: ['artifact:upload', 'manifest:write'],
      expires_at: isoPlusMinutes(nowIso, 45)
    };

    resultBodyOrThrow(`swap-intents.create.${actor.id}`, swapIntents.create({
      actor,
      auth: userWriteAuth,
      idempotencyKey: `demo-live-intent-${actor.id}-${runNonce}`,
      requestBody: intentPayload({
        intentId,
        actorId: actor.id,
        offerAssetId,
        wantAssetIds,
        valueUsd: actor.value_usd,
        nowIso,
        styleHint: actor.style_hint,
        styleTags,
        intentMessage,
        deliveryCapabilityToken
      })
    }));

    assetValueMap[offerAssetId] = actor.value_usd;
    createdIntentRows.push({
      actor_id: actor.id,
      intent_id: intentId,
      asset_id: offerAssetId
    });
  }

  let selectedProposalRows = [];
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

    const candidateRows = [];
    for (const proposalId of proposalIds) {
      const proposalBody = resultBodyOrThrow(`cycle-proposals.get.${proposalId}`, proposalsRead.get({
        actor: partner,
        auth: partnerReadAuth,
        proposalId
      }));
      const proposal = proposalBody?.proposal ?? null;
      const shape = readProposalParticipants(proposal);
      if (shape.actorIds.length < 2 || shape.intentIds.length < 2) continue;
      if (shape.actorIds.some(actorId => !actorById.has(actorId))) continue;
      if (shape.intentIds.some(intentId => !createdIntentIds.has(intentId))) continue;
      candidateRows.push({
        proposalId,
        proposal,
        actorIds: shape.actorIds,
        intentIds: shape.intentIds
      });
    }

    selectedProposalRows = selectDisjointWorkspaceProposals({
      candidates: candidateRows,
      maxCycles: 2
    });
    if (selectedProposalRows.length > 0) break;
  }

  if (selectedProposalRows.length === 0) {
    throw new Error('matching did not produce compatible workspace cycles for the current four-actor run');
  }

  const uniqueProposalIds = Array.from(new Set(selectedProposalRows.map(row => row.proposalId).filter(Boolean)));
  const selectedProposalById = new Map(selectedProposalRows.map(row => [row.proposalId, row.proposal]));
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
    mode: normalizedMode,
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
