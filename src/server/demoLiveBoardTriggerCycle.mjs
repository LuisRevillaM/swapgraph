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

export function runDemoLiveBoardTriggerCycle({
  swapIntents,
  marketplaceMatching,
  proposalsRead,
  commitsApi,
  settlementWrite
}) {
  const runNonce = token();
  const nowIso = new Date().toISOString();

  const workshop = { type: 'user', id: 'workshop' };
  const architectsDream = { type: 'user', id: 'architects_dream' };
  const partner = { type: 'partner', id: 'marketplace' };

  const workshopAssetId = `demo_asset_workshop_${runNonce}`;
  const architectsAssetId = `demo_asset_architects_${runNonce}`;
  const workshopIntentId = `demo_intent_workshop_${runNonce}`;
  const architectsIntentId = `demo_intent_architects_${runNonce}`;

  const userWriteAuth = actorAuth(['swap_intents:write', 'commits:write', 'settlement:write']);
  const partnerWriteAuth = actorAuth(['settlement:write', 'cycle_proposals:read', 'settlement:read', 'receipts:read']);
  const partnerReadAuth = actorAuth(['cycle_proposals:read', 'settlement:read', 'receipts:read']);

  resultBodyOrThrow('swap-intents.create.workshop', swapIntents.create({
    actor: workshop,
    auth: userWriteAuth,
    idempotencyKey: `demo-live-intent-workshop-${runNonce}`,
    requestBody: intentPayload({
      intentId: workshopIntentId,
      actorId: workshop.id,
      offerAssetId: workshopAssetId,
      wantAssetId: architectsAssetId,
      valueUsd: 145,
      nowIso
    })
  }));

  resultBodyOrThrow('swap-intents.create.architects_dream', swapIntents.create({
    actor: architectsDream,
    auth: userWriteAuth,
    idempotencyKey: `demo-live-intent-architects-${runNonce}`,
    requestBody: intentPayload({
      intentId: architectsIntentId,
      actorId: architectsDream.id,
      offerAssetId: architectsAssetId,
      wantAssetId: workshopAssetId,
      valueUsd: 151,
      nowIso
    })
  }));

  let selectedProposalId = null;
  let selectedRunId = null;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const runBody = resultBodyOrThrow(`marketplace.matching.run.${attempt}`, marketplaceMatching.runMatching({
      actor: partner,
      auth: partnerWriteAuth,
      idempotencyKey: `demo-live-match-${runNonce}-${attempt}`,
      request: {
        replace_existing: true,
        max_proposals: 200,
        asset_values_usd: {
          [workshopAssetId]: 145,
          [architectsAssetId]: 151
        }
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
      const intentIds = participants.map(p => trimOrNull(p?.intent_id)).filter(Boolean);
      if (intentIds.includes(workshopIntentId) && intentIds.includes(architectsIntentId)) {
        selectedProposalId = proposalId;
        break;
      }
    }

    if (selectedProposalId) break;
  }

  if (!selectedProposalId) {
    throw new Error('matching did not produce a proposal containing workshop + architects_dream intents');
  }

  resultBodyOrThrow('cycle-proposals.accept.workshop', commitsApi.accept({
    actor: workshop,
    auth: userWriteAuth,
    idempotencyKey: `demo-live-accept-workshop-${runNonce}`,
    proposalId: selectedProposalId,
    requestBody: { proposal_id: selectedProposalId },
    occurredAt: new Date().toISOString()
  }));

  resultBodyOrThrow('cycle-proposals.accept.architects_dream', commitsApi.accept({
    actor: architectsDream,
    auth: userWriteAuth,
    idempotencyKey: `demo-live-accept-architects-${runNonce}`,
    proposalId: selectedProposalId,
    requestBody: { proposal_id: selectedProposalId },
    occurredAt: new Date().toISOString()
  }));

  resultBodyOrThrow('settlement.start', settlementWrite.start({
    actor: partner,
    auth: partnerWriteAuth,
    cycleId: selectedProposalId,
    requestBody: { deposit_deadline_at: isoPlusMinutes(new Date().toISOString(), 30) },
    occurredAt: new Date().toISOString()
  }));

  resultBodyOrThrow('settlement.deposit_confirmed.workshop', settlementWrite.depositConfirmed({
    actor: workshop,
    auth: userWriteAuth,
    cycleId: selectedProposalId,
    requestBody: { deposit_ref: `dep_workshop_${runNonce}` },
    occurredAt: new Date().toISOString()
  }));

  resultBodyOrThrow('settlement.deposit_confirmed.architects_dream', settlementWrite.depositConfirmed({
    actor: architectsDream,
    auth: userWriteAuth,
    cycleId: selectedProposalId,
    requestBody: { deposit_ref: `dep_architects_${runNonce}` },
    occurredAt: new Date().toISOString()
  }));

  resultBodyOrThrow('settlement.begin_execution', settlementWrite.beginExecution({
    actor: partner,
    auth: partnerWriteAuth,
    cycleId: selectedProposalId,
    requestBody: {},
    occurredAt: new Date().toISOString()
  }));

  const completeBody = resultBodyOrThrow('settlement.complete', settlementWrite.complete({
    actor: partner,
    auth: partnerWriteAuth,
    cycleId: selectedProposalId,
    requestBody: {},
    occurredAt: new Date().toISOString()
  }));

  return {
    scenario: 'workshop_vs_architects_demo_cycle',
    run_nonce: runNonce,
    matching_run_id: selectedRunId,
    proposal_id: selectedProposalId,
    intent_ids: [workshopIntentId, architectsIntentId],
    asset_ids: [workshopAssetId, architectsAssetId],
    receipt_id: trimOrNull(completeBody?.receipt?.id),
    final_state: trimOrNull(completeBody?.receipt?.final_state) ?? trimOrNull(completeBody?.timeline?.state)
  };
}
