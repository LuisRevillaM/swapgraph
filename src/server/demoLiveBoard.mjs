function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asIso(value) {
  return typeof value === 'string' && parseIsoMs(value) !== null ? value : null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeStringList(value, maxItems = 5) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (!next) continue;
    const key = next.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
    if (out.length >= maxItems) break;
  }
  return out;
}

function titleCaseWords(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text
    .replaceAll('_', ' ')
    .split(/\s+/g)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isGenericDemoTitle(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return true;
  return text.startsWith('demo output for ')
    || text.startsWith('creative output by ')
    || text.startsWith('demo output')
    || text.startsWith('creative output');
}

function shortPromptLabel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const trimmed = text.replace(/\s+by\s+.+$/i, '').trim();
  if (!trimmed) return null;
  const words = trimmed.split(/\s+/g).filter(Boolean);
  const head = words.slice(0, 6).join(' ');
  return words.length > 6 ? `${head}…` : head;
}

function normalizePostTitle({
  rawTitle,
  actorId,
  styleTags = [],
  promptSpec,
  deliverableType,
  intentId
}) {
  if (rawTitle && !isGenericDemoTitle(rawTitle)) return rawTitle;
  const styleTag = Array.isArray(styleTags) && styleTags.length > 0 ? styleTags[0] : null;
  const deliverable = deliverableType ? titleCaseWords(String(deliverableType)) : 'Creative Piece';
  const promptLabel = shortPromptLabel(promptSpec);
  if (styleTag) return `${titleCaseWords(styleTag)} ${deliverable}`;
  if (promptLabel) return promptLabel;
  if (actorId) return `${titleCaseWords(actorId)} ${deliverable}`;
  if (intentId) return `Creative Intent ${intentId}`;
  return 'Creative Post';
}

function normalizeCapabilityToken(value) {
  if (!value || typeof value !== 'object') return null;
  const tokenId = firstNonEmptyString(value.token_id, value.id);
  const deliveryTarget = firstNonEmptyString(value.delivery_target, value.target);
  if (!tokenId && !deliveryTarget) return null;
  return {
    token_id: tokenId,
    delivery_target: deliveryTarget,
    issued_by: firstNonEmptyString(value.issued_by),
    expires_at: asIso(value.expires_at),
    scope: normalizeStringList(value.scope, 6)
  };
}

function parseWantAssetId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const idx = raw.lastIndexOf(':');
  return idx >= 0 ? raw.slice(idx + 1).trim() : raw;
}

function extractWantedAssetIds(intent) {
  const anyOf = Array.isArray(intent?.want_spec?.any_of) ? intent.want_spec.any_of : [];
  const out = [];
  const seen = new Set();
  for (const clause of anyOf) {
    if (!clause || clause.type !== 'specific_asset') continue;
    const assetId = parseWantAssetId(firstNonEmptyString(clause?.asset_key, clause?.assetKey));
    if (!assetId) continue;
    const dedupeKey = assetId.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(assetId);
  }
  return out;
}

function withPostNoveltyScores(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const tagCounts = new Map();
  for (const row of safeRows) {
    const tags = normalizeStringList(row?.style_tags, 8).map(tag => tag.toLowerCase());
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return safeRows.map(row => {
    const tags = normalizeStringList(row?.style_tags, 8).map(tag => tag.toLowerCase());
    if (tags.length === 0) return { ...row, novelty_score: null };
    const total = tags.reduce((acc, tag) => acc + (1 / Math.max(1, tagCounts.get(tag) ?? 1)), 0);
    const noveltyScore = Math.round((total / tags.length) * 100);
    return { ...row, novelty_score: noveltyScore };
  });
}

function imageUrlFromAsset(asset, { forceFallback = false } = {}) {
  const metadata = asset?.metadata ?? {};
  const explicit = firstNonEmptyString(
    metadata?.preview_image_url,
    metadata?.image_url,
    metadata?.artifact_url,
    metadata?.thumbnail_url
  );
  if (!forceFallback && explicit) return explicit;
  const assetId = firstNonEmptyString(asset?.asset_id);
  if (!assetId) return null;
  const deliverableType = firstNonEmptyString(metadata?.deliverable_type, metadata?.output_type, metadata?.type);
  if (metadata?.demo_kind === 'creative_labor_asset' || String(deliverableType ?? '').toLowerCase().includes('image')) {
    return `https://picsum.photos/seed/${encodeURIComponent(assetId)}/1024/768`;
  }
  return null;
}

function summarizeAssetRow(asset, { fallbackTitle = null } = {}) {
  if (!asset || typeof asset !== 'object') return null;
  const metadata = asset?.metadata ?? {};
  const deliverableType = firstNonEmptyString(
    metadata?.deliverable_type,
    metadata?.output_type,
    metadata?.type
  );
  return {
    asset_id: firstNonEmptyString(asset?.asset_id),
    title: firstNonEmptyString(metadata?.title, metadata?.name, fallbackTitle),
    prompt_spec: firstNonEmptyString(metadata?.prompt_spec, metadata?.description, metadata?.brief),
    deliverable_type: deliverableType ?? null,
    value_usd: asNumber(metadata?.value_usd) ?? asNumber(metadata?.list_price_usd),
    image_url: imageUrlFromAsset(asset)
  };
}

function normalizeActor(input) {
  const type = typeof input?.type === 'string' ? input.type.trim() : '';
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!type || !id) return null;
  return { type, id };
}

function actorKey(actor) {
  return actor ? `${actor.type}:${actor.id}` : null;
}

function uniqueActorsFromTimeline(timeline) {
  const keys = new Set();
  const actors = [];
  for (const leg of Array.isArray(timeline?.legs) ? timeline.legs : []) {
    const fromActor = normalizeActor(leg?.from_actor);
    const toActor = normalizeActor(leg?.to_actor);
    for (const candidate of [fromActor, toActor]) {
      const key = actorKey(candidate);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      actors.push(candidate);
    }
  }
  return actors;
}

function summarizeEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : 'event';
  const payload = event?.payload ?? {};
  if (type === 'cycle.state_changed') {
    const fromState = typeof payload.from_state === 'string' ? payload.from_state : '?';
    const toState = typeof payload.to_state === 'string' ? payload.to_state : '?';
    return `${fromState} -> ${toState}`;
  }
  if (type === 'settlement.deposit_confirmed') {
    const intentId = typeof payload.intent_id === 'string' ? payload.intent_id : 'intent';
    return `${intentId} deposited`;
  }
  if (type === 'settlement.deposit_required') {
    const deadline = asIso(payload.deposit_deadline_at);
    return deadline ? `deadline ${deadline}` : 'deposit required';
  }
  if (type === 'receipt.created') {
    const receipt = payload?.receipt ?? {};
    const receiptId = typeof receipt.id === 'string' ? receipt.id : 'receipt';
    const finalState = typeof receipt.final_state === 'string' ? receipt.final_state : 'unknown';
    return `${receiptId} (${finalState})`;
  }
  if (type === 'intent.reserved') {
    const intentId = typeof payload.intent_id === 'string' ? payload.intent_id : 'intent';
    return `${intentId} reserved`;
  }
  if (type === 'intent.unreserved') {
    const intentId = typeof payload.intent_id === 'string' ? payload.intent_id : 'intent';
    const reason = typeof payload.reason === 'string' ? payload.reason : 'released';
    return `${intentId} ${reason}`;
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) return type;
  return `${type} (${keys.slice(0, 3).join(', ')})`;
}

function createActorAccumulator() {
  return {
    actor_id: null,
    actor_type: null,
    intents_posted: 0,
    proposal_slots: 0,
    commit_accepts: 0,
    deposits_confirmed: 0,
    settlement_actions: 0,
    receipts_created: 0,
    events_total: 0,
    last_seen_at: null,
    last_event_type: null
  };
}

function updateLastSeen(row, iso, eventType = null) {
  const ms = parseIsoMs(iso);
  if (ms === null) return;
  const existingMs = parseIsoMs(row.last_seen_at);
  if (existingMs !== null && existingMs > ms) return;
  row.last_seen_at = iso;
  if (eventType) row.last_event_type = eventType;
}

function toActorRows(actorMap) {
  return Array.from(actorMap.values()).sort((a, b) => {
    const bMs = parseIsoMs(b.last_seen_at) ?? -1;
    const aMs = parseIsoMs(a.last_seen_at) ?? -1;
    if (bMs !== aMs) return bMs - aMs;
    const bScore = b.events_total + b.intents_posted + b.proposal_slots + b.commit_accepts + b.deposits_confirmed;
    const aScore = a.events_total + a.intents_posted + a.proposal_slots + a.commit_accepts + a.deposits_confirmed;
    if (bScore !== aScore) return bScore - aScore;
    return String(a.actor_id).localeCompare(String(b.actor_id));
  });
}

function sortByIsoDescending(rows, isoKey) {
  return rows.sort((a, b) => {
    const bMs = parseIsoMs(b?.[isoKey]) ?? -1;
    const aMs = parseIsoMs(a?.[isoKey]) ?? -1;
    if (bMs !== aMs) return bMs - aMs;
    return String(a?.id ?? a?.cycle_id ?? '').localeCompare(String(b?.id ?? b?.cycle_id ?? ''));
  });
}

function laneStatus({ nowMs, lastSeenAt }) {
  const seenMs = parseIsoMs(lastSeenAt);
  if (seenMs === null) return 'unseen';
  const age = nowMs - seenMs;
  if (age <= 10 * 60 * 1000) return 'active';
  if (age <= 60 * 60 * 1000) return 'idle';
  return 'stale';
}

function normalizeLaneHints(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function buildLaneRows({ actorRows, laneHints, nowIso }) {
  const nowMs = parseIsoMs(nowIso) ?? Date.now();
  return laneHints.map(name => {
    const needle = name.toLowerCase();
    const matches = actorRows.filter(row => String(row.actor_id).toLowerCase().includes(needle));
    const merged = matches.reduce((acc, row) => {
      acc.actor_ids.push(row.actor_id);
      acc.intents_posted += row.intents_posted;
      acc.proposal_slots += row.proposal_slots;
      acc.commit_accepts += row.commit_accepts;
      acc.deposits_confirmed += row.deposits_confirmed;
      acc.settlement_actions += row.settlement_actions;
      acc.receipts_created += row.receipts_created;
      acc.events_total += row.events_total;
      const rowMs = parseIsoMs(row.last_seen_at);
      const accMs = parseIsoMs(acc.last_seen_at);
      if (rowMs !== null && (accMs === null || rowMs > accMs)) {
        acc.last_seen_at = row.last_seen_at;
      }
      return acc;
    }, {
      lane: name,
      actor_ids: [],
      intents_posted: 0,
      proposal_slots: 0,
      commit_accepts: 0,
      deposits_confirmed: 0,
      settlement_actions: 0,
      receipts_created: 0,
      events_total: 0,
      last_seen_at: null
    });
    return {
      ...merged,
      actor_count: matches.length,
      status: laneStatus({ nowMs, lastSeenAt: merged.last_seen_at })
    };
  });
}

export function buildDemoLiveBoardSnapshot({
  store,
  nowIso = new Date().toISOString(),
  limit = 25,
  laneHints = [],
  workspaceOnly = false,
  workspaceActorIds = []
}) {
  const state = store?.state ?? {};
  const defaultWorkspaceActors = ['workshop', 'architects_dream', 'cto', 'toxins', 'graph_board', 'marketplace'];
  const workspaceSet = new Set(
    (Array.isArray(workspaceActorIds) && workspaceActorIds.length > 0 ? workspaceActorIds : defaultWorkspaceActors)
      .map(x => String(x ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const isWorkspaceActorId = actorId => workspaceSet.has(String(actorId ?? '').trim().toLowerCase());
  const eventCycleId = event => {
    const payload = event?.payload ?? {};
    const receipt = payload?.receipt ?? {};
    return firstNonEmptyString(payload?.cycle_id, receipt?.cycle_id);
  };

  const allIntents = Object.values(state.intents ?? {});
  const allProposals = Object.values(state.proposals ?? {});
  const allCommits = Object.values(state.commits ?? {});
  const allTimelines = Object.values(state.timelines ?? {});
  const allReceipts = Object.values(state.receipts ?? {});
  const allEvents = Array.isArray(state.events) ? state.events : [];
  const allMatchingRuns = Object.values(state.marketplace_matching_runs ?? {});

  const intents = workspaceOnly
    ? allIntents.filter(intent => isWorkspaceActorId(intent?.actor?.id))
    : allIntents;
  const proposals = workspaceOnly
    ? allProposals.filter(proposal => {
      const participants = Array.isArray(proposal?.participants) ? proposal.participants : [];
      return participants.length > 0 && participants.every(row => isWorkspaceActorId(row?.actor?.id));
    })
    : allProposals;
  const commits = workspaceOnly
    ? allCommits.filter(commit => {
      const participants = Array.isArray(commit?.participants) ? commit.participants : [];
      return participants.length > 0 && participants.every(row => isWorkspaceActorId(row?.actor?.id));
    })
    : allCommits;
  const timelines = workspaceOnly
    ? allTimelines.filter(timeline => {
      const actors = uniqueActorsFromTimeline(timeline);
      return actors.length > 0 && actors.every(actor => isWorkspaceActorId(actor?.id));
    })
    : allTimelines;

  const workspaceCycleIds = new Set([
    ...proposals.map(row => firstNonEmptyString(row?.id)).filter(Boolean),
    ...timelines.map(row => firstNonEmptyString(row?.cycle_id)).filter(Boolean)
  ]);

  const receipts = workspaceOnly
    ? allReceipts.filter(receipt => workspaceCycleIds.has(firstNonEmptyString(receipt?.cycle_id)))
    : allReceipts;
  const events = workspaceOnly
    ? allEvents.filter(event => {
      if (isWorkspaceActorId(event?.actor?.id)) return true;
      const cycleId = eventCycleId(event);
      return cycleId ? workspaceCycleIds.has(cycleId) : false;
    })
    : allEvents;
  const matchingRuns = workspaceOnly
    ? allMatchingRuns.filter(run => isWorkspaceActorId(run?.requested_by?.id))
    : allMatchingRuns;

  const commitCycleIds = new Set(commits.map(commit => commit?.cycle_id).filter(Boolean));
  const receiptCycleIds = new Set(receipts.map(receipt => receipt?.cycle_id).filter(Boolean));
  const proposalRunIdByProposalId = state.marketplace_matching_proposal_runs ?? {};
  const matchingRunById = new Map(
    matchingRuns
      .map(run => [firstNonEmptyString(run?.run_id), run])
      .filter(([runId]) => Boolean(runId))
  );
  const proposalRecordedAt = proposalId => {
    const runId = firstNonEmptyString(proposalRunIdByProposalId?.[proposalId]);
    if (!runId) return null;
    const run = matchingRunById.get(runId);
    return asIso(run?.recorded_at);
  };

  const funnel = {
    intents_total: intents.length,
    intents_active: intents.filter(intent => intent?.status === 'active').length,
    proposals_total: proposals.length,
    proposals_open: proposals.filter(proposal => !commitCycleIds.has(proposal?.id)).length,
    proposals_committed: proposals.filter(proposal => commitCycleIds.has(proposal?.id)).length,
    proposals_settled: proposals.filter(proposal => receiptCycleIds.has(proposal?.id)).length,
    commits_total: commits.length,
    timelines_total: timelines.length,
    timelines_escrow_pending: timelines.filter(timeline => timeline?.state === 'escrow.pending').length,
    timelines_escrow_ready: timelines.filter(timeline => timeline?.state === 'escrow.ready').length,
    timelines_executing: timelines.filter(timeline => timeline?.state === 'executing').length,
    timelines_completed: timelines.filter(timeline => timeline?.state === 'completed').length,
    timelines_failed: timelines.filter(timeline => timeline?.state === 'failed').length,
    receipts_total: receipts.length,
    receipts_completed: receipts.filter(receipt => receipt?.final_state === 'completed').length,
    receipts_failed: receipts.filter(receipt => receipt?.final_state === 'failed').length
  };

  const rawEventRows = events.map(event => {
    const actor = normalizeActor(event?.actor);
    const payload = event?.payload ?? {};
    const receipt = payload?.receipt ?? {};
    return {
      id: event?.event_id ?? null,
      type: event?.type ?? 'event',
      occurred_at: asIso(event?.occurred_at),
      actor_type: actor?.type ?? null,
      actor_id: actor?.id ?? null,
      cycle_id: typeof payload.cycle_id === 'string' ? payload.cycle_id : (typeof receipt.cycle_id === 'string' ? receipt.cycle_id : null),
      intent_id: typeof payload.intent_id === 'string' ? payload.intent_id : null,
      summary: summarizeEvent(event)
    };
  });
  const syntheticIntentEvents = intents.map((intent, idx) => {
    const actor = normalizeActor(intent?.actor);
    const offer = Array.isArray(intent?.offer) && intent.offer.length > 0 ? intent.offer[0] : null;
    const metadata = offer?.metadata ?? {};
    const deliverableType = firstNonEmptyString(metadata?.deliverable_type, metadata?.output_type, metadata?.type) ?? 'deliverable';
    const occurredAt = asIso(offer?.proof?.verified_at) ?? asIso(intent?.updated_at);
    return {
      id: `intent_posted_${firstNonEmptyString(intent?.id) ?? String(idx)}`,
      type: 'intent.posted',
      occurred_at: occurredAt,
      actor_type: actor?.type ?? null,
      actor_id: actor?.id ?? null,
      cycle_id: null,
      intent_id: firstNonEmptyString(intent?.id),
      summary: `${actor?.id ?? 'actor'} listed ${deliverableType}`
    };
  });
  const syntheticProposalEvents = proposals.map((proposal, idx) => {
    const proposalId = firstNonEmptyString(proposal?.id);
    const participants = Array.isArray(proposal?.participants) ? proposal.participants : [];
    const actorIds = participants
      .map(row => firstNonEmptyString(row?.actor?.id))
      .filter(Boolean);
    const occurredAt = proposalRecordedAt(proposalId) ?? asIso(proposal?.expires_at);
    return {
      id: `cycle_proposed_${proposalId ?? String(idx)}`,
      type: 'cycle.proposed',
      occurred_at: occurredAt,
      actor_type: 'partner',
      actor_id: 'marketplace',
      cycle_id: proposalId,
      intent_id: firstNonEmptyString(participants[0]?.intent_id),
      summary: `proposal built for ${actorIds.length}-actor cycle`
    };
  });

  const recentEvents = sortByIsoDescending(
    [...rawEventRows, ...syntheticIntentEvents, ...syntheticProposalEvents].filter(row => parseIsoMs(row?.occurred_at) !== null),
    'occurred_at'
  ).slice(0, limit);

  const recentCycles = sortByIsoDescending(
    timelines.map(timeline => {
      const legs = Array.isArray(timeline?.legs) ? timeline.legs : [];
      const statusCounts = legs.reduce((acc, leg) => {
        const status = typeof leg?.status === 'string' ? leg.status : 'unknown';
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {});
      return {
        cycle_id: timeline?.cycle_id ?? null,
        state: timeline?.state ?? null,
        updated_at: asIso(timeline?.updated_at),
        legs_total: legs.length,
        legs_pending: statusCounts.pending ?? 0,
        legs_deposited: statusCounts.deposited ?? 0,
        legs_released: statusCounts.released ?? 0,
        legs_refunded: statusCounts.refunded ?? 0,
        participants: uniqueActorsFromTimeline(timeline)
      };
    }),
    'updated_at'
  ).slice(0, limit);

  const recentReceipts = sortByIsoDescending(
    receipts.map(receipt => ({
      id: receipt?.id ?? null,
      cycle_id: receipt?.cycle_id ?? null,
      final_state: receipt?.final_state ?? null,
      created_at: asIso(receipt?.created_at),
      asset_count: Array.isArray(receipt?.asset_ids) ? receipt.asset_ids.length : 0,
      intent_count: Array.isArray(receipt?.intent_ids) ? receipt.intent_ids.length : 0
    })),
    'created_at'
  ).slice(0, limit);

  const recentMatchingRuns = sortByIsoDescending(
    matchingRuns.map(run => ({
      run_id: run?.run_id ?? null,
      recorded_at: asIso(run?.recorded_at),
      selected_proposals_count: Number.isFinite(run?.selected_proposals_count) ? run.selected_proposals_count : 0,
      candidate_cycles: Number.isFinite(run?.stats?.candidate_cycles) ? run.stats.candidate_cycles : 0,
      active_intents_count: Number.isFinite(run?.active_intents_count) ? run.active_intents_count : 0,
      requested_by: normalizeActor(run?.requested_by)
    })),
    'recorded_at'
  ).slice(0, limit);

  const sortedPosts = sortByIsoDescending(
    intents.map(intent => {
      const actor = normalizeActor(intent?.actor);
      const offer = Array.isArray(intent?.offer) && intent.offer.length > 0 ? intent.offer[0] : null;
      const metadata = offer?.metadata ?? {};
      const proof = offer?.proof ?? {};
      const deliverableType = firstNonEmptyString(metadata?.deliverable_type, metadata?.output_type, metadata?.type);
      const styleTags = normalizeStringList(metadata?.style_tags, 8);
      const promptSpec = firstNonEmptyString(
        metadata?.prompt_spec,
        metadata?.description,
        metadata?.brief
      );
      const rawTitle = firstNonEmptyString(
        metadata?.title,
        metadata?.name,
        actor?.id ? `Demo output for ${actor.id}` : null
      );
      return {
        intent_id: intent?.id ?? null,
        actor_id: actor?.id ?? null,
        actor_type: actor?.type ?? null,
        status: firstNonEmptyString(intent?.status) ?? 'unknown',
        posted_at: asIso(proof?.verified_at) ?? asIso(intent?.updated_at) ?? null,
        asset_id: firstNonEmptyString(offer?.asset_id),
        wanted_asset_ids: extractWantedAssetIds(intent),
        title: normalizePostTitle({
          rawTitle,
          actorId: actor?.id ?? null,
          styleTags,
          promptSpec,
          deliverableType,
          intentId: intent?.id ?? null
        }),
        prompt_spec: promptSpec,
        agent_message: firstNonEmptyString(
          metadata?.intent_message,
          metadata?.agent_note,
          metadata?.note
        ),
        style_tags: styleTags,
        deliverable_type: deliverableType ?? null,
        value_usd: asNumber(metadata?.value_usd) ?? asNumber(metadata?.list_price_usd) ?? asNumber(intent?.value_band?.max_usd),
        delivery_targets: normalizeStringList(metadata?.delivery_target_options, 6),
        delivery_capability_token: normalizeCapabilityToken(metadata?.delivery_capability_token),
        image_url: imageUrlFromAsset(offer)
      };
    }),
    'posted_at'
  );
  const recentPosts = withPostNoveltyScores(sortedPosts.slice(0, limit));

  const timelineByCycleId = new Map();
  for (const timeline of timelines) {
    const cycleId = firstNonEmptyString(timeline?.cycle_id);
    if (!cycleId) continue;
    timelineByCycleId.set(cycleId, timeline);
  }

  const receiptByCycleId = new Map();
  for (const receipt of receipts) {
    const cycleId = firstNonEmptyString(receipt?.cycle_id);
    if (!cycleId) continue;
    receiptByCycleId.set(cycleId, receipt);
  }

  const recentTradeCycles = sortByIsoDescending(
    proposals.map(proposal => {
      const cycleId = firstNonEmptyString(proposal?.id);
      const timeline = cycleId ? timelineByCycleId.get(cycleId) ?? null : null;
      const receipt = cycleId ? receiptByCycleId.get(cycleId) ?? null : null;
      const participants = Array.isArray(proposal?.participants) ? proposal.participants : [];
      return {
        cycle_id: cycleId,
        state: firstNonEmptyString(receipt?.final_state, timeline?.state) ?? 'proposed',
        updated_at: asIso(receipt?.created_at) ?? asIso(timeline?.updated_at) ?? proposalRecordedAt(cycleId) ?? asIso(proposal?.expires_at),
        receipt_id: firstNonEmptyString(receipt?.id),
        participant_count: participants.length,
        participants: participants.map(participant => {
          const actor = normalizeActor(participant?.actor);
          const giveAsset = Array.isArray(participant?.give) && participant.give.length > 0 ? participant.give[0] : null;
          const getAsset = Array.isArray(participant?.get) && participant.get.length > 0 ? participant.get[0] : null;
          return {
            actor_id: actor?.id ?? null,
            actor_type: actor?.type ?? null,
            intent_id: firstNonEmptyString(participant?.intent_id),
            give_count: Array.isArray(participant?.give) ? participant.give.length : 0,
            get_count: Array.isArray(participant?.get) ? participant.get.length : 0,
            gives: summarizeAssetRow(giveAsset, { fallbackTitle: actor?.id ? `From ${actor.id}` : 'Give leg' }),
            gets: summarizeAssetRow(getAsset, { fallbackTitle: actor?.id ? `For ${actor.id}` : 'Get leg' })
          };
        })
      };
    }),
    'updated_at'
  ).slice(0, limit);

  const actorMap = new Map();
  const ensureActor = actor => {
    const normalized = normalizeActor(actor);
    const key = actorKey(normalized);
    if (!key) return null;
    if (!actorMap.has(key)) {
      const base = createActorAccumulator();
      base.actor_id = normalized.id;
      base.actor_type = normalized.type;
      actorMap.set(key, base);
    }
    return actorMap.get(key);
  };

  for (const intent of intents) {
    const row = ensureActor(intent?.actor);
    if (!row) continue;
    row.intents_posted += 1;
    updateLastSeen(row, asIso(intent?.updated_at));
  }

  for (const proposal of proposals) {
    for (const participant of Array.isArray(proposal?.participants) ? proposal.participants : []) {
      const row = ensureActor(participant?.actor);
      if (!row) continue;
      row.proposal_slots += 1;
      updateLastSeen(row, asIso(proposal?.expires_at));
    }
  }

  for (const commit of commits) {
    for (const participant of Array.isArray(commit?.participants) ? commit.participants : []) {
      const row = ensureActor(participant?.actor);
      if (!row) continue;
      if (participant?.status === 'accepted') row.commit_accepts += 1;
      updateLastSeen(row, asIso(commit?.updated_at));
    }
  }

  for (const timeline of timelines) {
    const updatedAt = asIso(timeline?.updated_at);
    for (const actor of uniqueActorsFromTimeline(timeline)) {
      const row = ensureActor(actor);
      if (!row) continue;
      updateLastSeen(row, updatedAt);
    }
  }

  for (const event of events) {
    const row = ensureActor(event?.actor);
    if (!row) continue;
    row.events_total += 1;
    if (event?.type === 'settlement.deposit_confirmed') row.deposits_confirmed += 1;
    if (event?.type === 'cycle.state_changed' || event?.type === 'settlement.deposit_required' || event?.type === 'settlement.executing') {
      row.settlement_actions += 1;
    }
    if (event?.type === 'receipt.created') row.receipts_created += 1;
    updateLastSeen(row, asIso(event?.occurred_at), event?.type ?? null);
  }

  const actorRows = toActorRows(actorMap).slice(0, Math.max(limit, 10));
  const normalizedLaneHints = normalizeLaneHints(laneHints);
  const defaultHints = normalizedLaneHints.length > 0
    ? normalizedLaneHints
    : ['workshop', 'architects_dream', 'cto', 'toxins', 'graph_board', 'marketplace'];

  return {
    generated_at: nowIso,
    limit,
    workspace_only: workspaceOnly === true,
    funnel,
    lanes: buildLaneRows({ actorRows, laneHints: defaultHints, nowIso }),
    actors: actorRows.slice(0, limit),
    posts: recentPosts,
    trade_cycles: recentTradeCycles,
    cycles: recentCycles,
    receipts: recentReceipts,
    matching_runs: recentMatchingRuns,
    events: recentEvents
  };
}

export function renderDemoLiveBoardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SwapGraph Live Board</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    /* ─── Motion tokens ─── */
    :root {
      --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      --dur-instant: 80ms;
      --dur-fast: 150ms;
      --dur-normal: 280ms;
      --dur-slow: 480ms;
      --dur-dramatic: 700ms;
      --stagger-step: 60ms;
    }

    /* ─── Design tokens ─── */
    :root {
      --bg: #f0ede7;
      --surface: #fffdf9;
      --surface-strong: #ffffff;
      --surface-elevated: #ffffff;
      --ink: #0c1017;
      --ink-secondary: #3d4654;
      --muted: #6b7280;
      --faint: #9ca3af;
      --line: #e2e5eb;
      --line-subtle: #f0f2f5;
      --accent: #0d9488;
      --accent-strong: #0f766e;
      --accent-glow: rgba(13, 148, 136, 0.15);
      --accent-glow-strong: rgba(13, 148, 136, 0.35);
      --warm: #e8622d;
      --warm-glow: rgba(232, 98, 45, 0.12);
      --ok: #059669;
      --ok-subtle: rgba(5, 150, 105, 0.08);
      --warn: #d97706;
      --warn-subtle: rgba(217, 119, 6, 0.08);
      --bad: #dc2626;
      --bad-subtle: rgba(220, 38, 38, 0.08);
      --radius-sm: 8px;
      --radius: 14px;
      --radius-lg: 18px;
      --mono: "JetBrains Mono", "SF Mono", "Cascadia Code", monospace;
      --sans: "DM Sans", system-ui, -apple-system, sans-serif;
      /* Spacing scale */
      --sp-1: 4px;
      --sp-2: 8px;
      --sp-3: 12px;
      --sp-4: 16px;
      --sp-5: 20px;
      --sp-6: 24px;
      --sp-8: 32px;
      /* Type scale */
      --text-2xs: 0.68rem;
      --text-xs: 0.74rem;
      --text-sm: 0.82rem;
      --text-base: 0.92rem;
      --text-lg: 1.15rem;
      --text-xl: clamp(1.2rem, 2.2vw, 1.55rem);
      --text-2xl: clamp(1.5rem, 3vw, 2rem);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--ink);
      font-family: var(--sans);
      font-size: var(--text-sm);
      line-height: 1.5;
      background:
        radial-gradient(ellipse 80% 60% at 12% 8%, rgba(13, 148, 136, 0.09), transparent),
        radial-gradient(ellipse 60% 50% at 88% 5%, rgba(232, 98, 45, 0.1), transparent),
        radial-gradient(ellipse 40% 40% at 50% 100%, rgba(13, 148, 136, 0.05), transparent),
        var(--bg);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    /* ─── Shell ─── */
    .shell {
      width: min(1440px, 95vw);
      margin: var(--sp-6) auto var(--sp-8);
      display: grid;
      gap: var(--sp-4);
    }

    /* ─── Entrance animations ─── */
    @keyframes fadeSlideUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes pulseRing {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.8); opacity: 0; }
    }
    @keyframes pulseDot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes flow {
      from { stroke-dashoffset: 0; }
      to { stroke-dashoffset: -36; }
    }
    @keyframes nodeEntrance {
      from { r: 0; opacity: 0; }
      to { r: 22; opacity: 1; }
    }
    @keyframes edgeEntrance {
      from { stroke-dashoffset: 100; opacity: 0; }
      to { stroke-dashoffset: 0; opacity: 1; }
    }
    @keyframes lightboxIn {
      from { opacity: 0; transform: scale(0.92) translateY(20px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes countPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.06); }
      100% { transform: scale(1); }
    }
    @keyframes newCardPulse {
      0% {
        box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent) 45%, transparent);
      }
      100% {
        box-shadow: 0 0 0 14px rgba(13, 148, 136, 0);
      }
    }

    .section-enter {
      animation: fadeSlideUp var(--dur-normal) var(--ease-out-expo) both;
    }

    /* ─── Header ─── */
    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--sp-3);
      align-items: center;
      background: linear-gradient(135deg, rgba(255,255,255,0.95), rgba(248,253,253,0.9));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      padding: var(--sp-4) var(--sp-5);
      box-shadow:
        0 1px 2px rgba(0,0,0,0.04),
        0 8px 24px rgba(22, 28, 45, 0.06);
      animation: fadeSlideUp var(--dur-normal) var(--ease-out-expo) both;
    }
    .title {
      margin: 0;
      font-size: var(--text-xl);
      font-weight: 700;
      letter-spacing: -0.01em;
      text-transform: none;
      color: var(--ink);
    }
    .title-accent {
      color: var(--accent);
    }
    .meta {
      margin-top: var(--sp-1);
      color: var(--muted);
      font-size: var(--text-xs);
      font-family: var(--mono);
      letter-spacing: 0.02em;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 7px 14px 7px 11px;
      font-size: var(--text-xs);
      font-family: var(--mono);
      font-weight: 500;
      background: var(--surface);
      color: var(--muted);
      min-width: 120px;
      justify-content: center;
      transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease, background var(--dur-fast) ease;
    }
    .status-dot {
      position: relative;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }
    .status-pill.ok .status-dot { background: var(--ok); }
    .status-pill.ok .status-dot::after {
      content: '';
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      border: 1.5px solid var(--ok);
      animation: pulseRing 2.4s var(--ease-out-expo) infinite;
    }
    .status-pill.ok { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 30%, var(--line)); background: var(--ok-subtle); }
    .status-pill.bad .status-dot { background: var(--bad); }
    .status-pill.bad { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 35%, var(--line)); background: var(--bad-subtle); }

    /* ─── Metric cards ─── */
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--sp-3);
      animation: fadeSlideUp var(--dur-normal) var(--ease-out-expo) both;
      animation-delay: calc(var(--stagger-step) * 1);
    }
    .card {
      position: relative;
      background: var(--surface-elevated);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: var(--sp-4) var(--sp-4) var(--sp-3);
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
      transition: transform var(--dur-fast) var(--ease-out-expo), box-shadow var(--dur-fast) var(--ease-out-expo);
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), var(--accent-strong));
      opacity: 0;
      transition: opacity var(--dur-fast) ease;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.06), 0 12px 28px rgba(0,0,0,0.05);
    }
    .card:hover::before { opacity: 1; }
    .card h3 {
      margin: 0;
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 600;
    }
    .card .value {
      margin-top: var(--sp-2);
      font-size: var(--text-2xl);
      font-weight: 700;
      font-family: var(--mono);
      color: var(--accent-strong);
      line-height: 1.1;
      letter-spacing: -0.02em;
    }
    .card .value.changed {
      animation: countPulse var(--dur-normal) var(--ease-spring);
    }
    .quick-stats {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2);
      align-items: center;
      padding: var(--sp-3);
    }
    .quick-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-elevated);
      color: var(--ink-secondary);
      font-family: var(--mono);
      font-size: var(--text-xs);
      padding: 5px 10px;
      display: inline-flex;
      gap: 6px;
      align-items: baseline;
    }
    .quick-pill strong {
      font-size: var(--text-base);
      color: var(--accent-strong);
      letter-spacing: -0.01em;
      font-weight: 700;
    }

    /* ─── Panel ─── */
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: var(--sp-4);
      overflow: hidden;
    }
    .panel h2 {
      margin: 0 0 var(--sp-3);
      font-size: var(--text-sm);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-secondary);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: var(--sp-2);
    }
    .panel h2::before {
      content: '';
      width: 3px;
      height: 14px;
      border-radius: 2px;
      background: var(--accent);
      flex-shrink: 0;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-3);
      margin-bottom: var(--sp-3);
    }
    .controls-bar {
      margin-bottom: var(--sp-2);
    }
    .controls-summary {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2);
      min-width: 280px;
    }
    .controls-summary h2 {
      margin: 0;
    }
    .controls-right {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .trigger-btn {
      border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--line));
      background: linear-gradient(135deg, rgba(13,148,136,0.06), rgba(232,98,45,0.04));
      color: var(--accent-strong);
      border-radius: 999px;
      padding: 8px 16px;
      font-size: var(--text-xs);
      font-family: var(--mono);
      font-weight: 600;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: all var(--dur-fast) var(--ease-out-expo);
      position: relative;
      overflow: hidden;
    }
    .trigger-btn::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, var(--accent-glow), transparent);
      opacity: 0;
      transition: opacity var(--dur-fast) ease;
    }
    .trigger-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 14px var(--accent-glow);
      border-color: var(--accent);
    }
    .trigger-btn:hover::after { opacity: 1; }
    .trigger-btn:active { transform: translateY(0); }
    .trigger-btn:disabled {
      cursor: default;
      opacity: 0.5;
      transform: none;
      box-shadow: none;
    }
    .trigger-btn:disabled::after { opacity: 0; }
    .trigger-status {
      margin: 0;
      color: var(--muted);
      font-size: var(--text-xs);
      font-family: var(--mono);
      line-height: 1.5;
    }
    .control-status {
      border: 1px solid var(--line-subtle);
      border-radius: var(--radius-sm);
      background: var(--surface-elevated);
      padding: 6px 10px;
      min-width: 280px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .state-guide {
      margin-top: var(--sp-3);
      display: grid;
      gap: var(--sp-2);
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    }
    .guide-chip {
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: 7px 9px;
      background: var(--surface-elevated);
      display: grid;
      gap: 2px;
      font-family: var(--mono);
      line-height: 1.35;
    }
    .guide-chip strong {
      font-size: var(--text-2xs);
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--ink-secondary);
    }
    .guide-chip span {
      font-size: var(--text-2xs);
      color: var(--faint);
    }
    .guide-chip.proposed {
      border-color: color-mix(in oklab, var(--accent) 30%, var(--line));
      background: color-mix(in oklab, var(--accent-glow) 55%, var(--surface-elevated));
    }
    .guide-chip.pending {
      border-color: color-mix(in oklab, #0369a1 35%, var(--line));
      background: rgba(3, 105, 161, 0.08);
    }
    .guide-chip.executing {
      border-color: color-mix(in oklab, var(--warn) 40%, var(--line));
      background: var(--warn-subtle);
    }
    .guide-chip.completed {
      border-color: color-mix(in oklab, var(--ok) 35%, var(--line));
      background: var(--ok-subtle);
    }
    .guide-chip.failed {
      border-color: color-mix(in oklab, var(--bad) 35%, var(--line));
      background: var(--bad-subtle);
    }
    .toggle-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 12px;
      background: var(--surface-strong);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      font-family: var(--mono);
      user-select: none;
      transition: border-color var(--dur-fast) ease;
    }
    .toggle-pill:hover { border-color: var(--accent); }
    .toggle-pill input {
      margin: 0;
      width: 14px;
      height: 14px;
      accent-color: var(--accent);
    }
    .cadence-input {
      width: 62px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      background: var(--surface);
      outline: none;
      appearance: textfield;
      -moz-appearance: textfield;
    }
    .cadence-input::-webkit-outer-spin-button,
    .cadence-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .cadence-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 20%, transparent);
    }
    .trigger-btn.running {
      border-color: color-mix(in oklab, var(--ok) 45%, var(--line));
      color: var(--ok);
      background: var(--ok-subtle);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--ok) 30%, transparent), 0 4px 14px color-mix(in oklab, var(--ok) 22%, transparent);
    }
    .advanced-controls,
    .legend-details,
    .advanced-layout {
      margin-top: var(--sp-3);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--surface-elevated);
      overflow: hidden;
    }
    .advanced-controls > summary,
    .legend-details > summary,
    .advanced-layout > summary {
      cursor: pointer;
      list-style: none;
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      padding: var(--sp-2) var(--sp-3);
      background: color-mix(in oklab, var(--surface-elevated) 75%, var(--accent-glow));
      user-select: none;
    }
    .advanced-controls > summary::-webkit-details-marker,
    .legend-details > summary::-webkit-details-marker,
    .advanced-layout > summary::-webkit-details-marker {
      display: none;
    }
    .advanced-controls[open] > summary,
    .legend-details[open] > summary,
    .advanced-layout[open] > summary {
      border-bottom: 1px solid var(--line-subtle);
    }
    .advanced-controls-body {
      padding: var(--sp-3);
    }
    .legend-details .state-guide {
      margin-top: 0;
      padding: var(--sp-3);
    }
    .feed-select {
      border: none;
      background: transparent;
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
    }
    .live-feeds-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--sp-4);
    }
    .live-feed-column {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-elevated);
      padding: var(--sp-3);
      min-height: 380px;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: var(--sp-3);
    }
    .live-feed-title {
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-weight: 600;
      padding: 0 var(--sp-1);
    }
    .live-list {
      display: grid;
      gap: var(--sp-2);
      align-content: start;
      overflow-y: visible;
      max-height: none;
      padding-right: 0;
    }
    .live-list::-webkit-scrollbar { width: 5px; }
    .live-list::-webkit-scrollbar-track { background: transparent; }
    .live-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
    .live-item {
      border: 1px solid var(--line-subtle);
      border-left: 3px solid var(--line);
      border-radius: 2px var(--radius-sm) var(--radius-sm) 2px;
      background: var(--surface);
      padding: var(--sp-3) var(--sp-3);
      display: grid;
      gap: var(--sp-2);
    }
    .live-item.clickable {
      cursor: pointer;
      transition: border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease, transform var(--dur-fast) var(--ease-out-expo);
    }
    .live-item.clickable:hover {
      transform: translateY(-1px);
      border-color: color-mix(in oklab, var(--accent) 30%, var(--line-subtle));
      box-shadow: 0 4px 14px var(--accent-glow);
    }
    .live-item.clickable.active {
      border-color: color-mix(in oklab, var(--accent) 45%, var(--line-subtle));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 35%, transparent), 0 8px 20px var(--accent-glow);
      transform: translateY(-1px);
    }
    .live-item.kind-posts { border-left-color: #0b7285; }
    .live-item.kind-edges { border-left-color: #7c3aed; }
    .live-item.kind-matches { border-left-color: var(--accent); }
    .live-item-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--sp-2);
      font-family: var(--mono);
      font-size: var(--text-2xs);
      color: var(--muted);
    }
    .live-item-time {
      color: var(--faint);
      font-weight: 500;
      white-space: nowrap;
    }
    .live-item-time.tier-hot {
      color: var(--ok);
      font-weight: 700;
    }
    .live-item-time.tier-fresh {
      color: color-mix(in oklab, var(--ok) 68%, var(--ink-secondary));
    }
    .live-item-time.tier-warm {
      color: color-mix(in oklab, var(--warm) 62%, var(--ink-secondary));
    }
    .live-item-time.tier-stale {
      color: var(--faint);
    }
    .live-item-row {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: var(--sp-3);
      align-items: start;
    }
    .live-thumb {
      width: 76px;
      height: 76px;
      border-radius: var(--radius-sm);
      object-fit: cover;
      background: var(--line-subtle);
      border: 1px solid var(--line);
    }
    .live-item-title {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--ink);
      line-height: 1.3;
      font-weight: 700;
    }
    .live-item-sub {
      margin: 0;
      font-size: var(--text-xs);
      color: var(--muted);
      font-family: var(--mono);
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .live-item-meta {
      margin: 0;
      font-size: var(--text-2xs);
      color: var(--faint);
      font-family: var(--mono);
      line-height: 1.4;
      word-break: break-word;
    }
    .live-empty {
      color: var(--faint);
      font-size: var(--text-sm);
      font-style: italic;
      font-family: var(--mono);
      padding: var(--sp-5) var(--sp-3);
      text-align: center;
      line-height: 1.5;
    }
    .inspector-body {
      display: grid;
      gap: var(--sp-3);
      opacity: 1;
      transition: opacity var(--dur-fast) ease;
    }
    .inspector-body.changing {
      opacity: 0.35;
    }
    .inspector-row {
      display: grid;
      grid-template-columns: 100px minmax(0, 1fr);
      gap: var(--sp-3);
      align-items: start;
    }
    .inspector-row code {
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      word-break: break-word;
    }
    .inspector-key {
      font-family: var(--mono);
      font-size: var(--text-2xs);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 500;
    }
    .inspector-value {
      color: var(--ink-secondary);
      font-size: var(--text-sm);
      line-height: 1.5;
    }
    .inspector-value strong {
      color: var(--ink);
    }
    .inspector-media-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--sp-2);
    }
    .inspector-media-card {
      margin: 0;
      display: grid;
      gap: 6px;
    }
    .inspector-media-btn {
      border: 1px solid var(--line-subtle);
      border-radius: var(--radius-sm);
      padding: 0;
      margin: 0;
      background: var(--line-subtle);
      width: 100%;
      min-height: 150px;
      height: clamp(160px, 22vh, 260px);
      overflow: hidden;
      position: relative;
      cursor: zoom-in;
      display: block;
    }
    .inspector-media-grid.single .inspector-media-btn {
      height: clamp(200px, 28vh, 320px);
    }
    .inspector-media-btn img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      background: var(--line-subtle);
    }
    .inspector-media-btn.broken {
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #eceff3, #e4e9ee);
    }
    .inspector-media-btn.broken::before {
      content: 'Image unavailable';
      font-family: var(--mono);
      font-size: var(--text-2xs);
      color: var(--muted);
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .inspector-media-label {
      font-family: var(--mono);
      font-size: var(--text-2xs);
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin: 0;
    }
    .inspector-match-grid {
      display: grid;
      gap: var(--sp-2);
    }
    .inspector-raw {
      margin-top: var(--sp-2);
      border: 1px dashed var(--line);
      border-radius: var(--radius-sm);
      background: var(--surface-elevated);
      padding: var(--sp-2);
    }
    .inspector-raw > summary {
      cursor: pointer;
      font-family: var(--mono);
      font-size: var(--text-2xs);
      color: var(--muted);
      user-select: none;
    }
    .inspector-raw code {
      font-family: var(--mono);
      font-size: var(--text-2xs);
      color: var(--ink-secondary);
    }
    .inspector-match-leg {
      border: 1px solid var(--line-subtle);
      border-radius: var(--radius-sm);
      padding: var(--sp-3);
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      background: var(--surface-elevated);
      line-height: 1.6;
    }
    .inspector-match-leg strong {
      color: var(--ink);
      font-family: var(--sans);
      font-size: var(--text-sm);
      font-weight: 700;
    }
    .inspector-cycle-graph-wrap[hidden] {
      display: none;
    }
    .inspector-cycle-graph-wrap {
      margin-top: var(--sp-3);
    }
    .primary-stage {
      --stage-panel-h: clamp(680px, 74vh, 860px);
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: var(--sp-4);
      align-items: start;
    }
    .primary-stage > .panel {
      min-height: var(--stage-panel-h);
    }
    .feeds-panel .live-feed-column {
      min-height: 340px;
    }
    .feeds-panel .live-list {
      max-height: none;
      overflow-y: visible;
    }
    .viz-panel {
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: var(--sp-2);
      overflow: visible;
    }
    .viz-panel .panel-head {
      margin-bottom: 0;
    }
    .viz-panel .inspector-cycle-graph-wrap {
      margin-top: 0;
    }
    .viz-panel .inspector-body {
      max-height: none;
      min-height: 0;
      overflow: visible;
      padding-right: 0;
      align-content: start;
    }
    .viz-panel .cycle-graph-shell {
      min-height: 290px;
      padding: var(--sp-3);
    }
    .viz-panel .cycle-graph {
      height: 270px;
    }

    /* ─── Layout ─── */
    .essentials {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: var(--sp-4);
      align-items: start;
    }
    .stack {
      display: grid;
      gap: var(--sp-4);
    }

    /* ─── Cycle graph ─── */
    .cycle-graph-shell {
      border: 1px solid var(--line-subtle);
      border-radius: var(--radius);
      background: linear-gradient(145deg, #f5fbfc, #fdfcfa);
      min-height: 260px;
      padding: var(--sp-3);
      position: relative;
      overflow: hidden;
    }
    .cycle-graph-shell::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 50% 50%, var(--accent-glow), transparent 70%);
      pointer-events: none;
      opacity: 0.5;
    }
    .cycle-graph {
      width: 100%;
      height: 240px;
      display: block;
      position: relative;
      z-index: 1;
    }
    .cycle-node {
      fill: #ffffff;
      stroke: var(--accent);
      stroke-width: 2.5;
      filter: url(#nodeGlow);
      transition: r var(--dur-normal) var(--ease-spring);
    }
    .cycle-edge {
      fill: none;
      stroke: var(--accent);
      stroke-width: 2.4;
      stroke-linecap: round;
      stroke-dasharray: 8 10;
      animation: flow 2s linear infinite;
      filter: url(#edgeGlow);
    }
    .cycle-arrow {
      fill: var(--accent);
    }
    .cycle-label {
      font-size: 10px;
      fill: var(--ink);
      text-anchor: middle;
      font-family: var(--mono);
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .cycle-sub {
      font-size: var(--text-xs);
      color: var(--muted);
      font-family: var(--mono);
      margin-top: var(--sp-2);
      position: relative;
      z-index: 1;
    }

    /* ─── Post cards ─── */
    .post-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--sp-3);
    }
    .post-card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-elevated);
      overflow: hidden;
      display: grid;
      grid-template-rows: 170px auto;
      min-height: 280px;
      transition: transform var(--dur-fast) var(--ease-out-expo), box-shadow var(--dur-fast) var(--ease-out-expo), border-color var(--dur-fast) ease;
    }
    .post-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
      border-color: color-mix(in oklab, var(--accent) 30%, var(--line));
    }
    .post-card.is-new {
      border-color: color-mix(in oklab, var(--accent) 65%, var(--line));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 30%, transparent), 0 10px 24px rgba(13, 148, 136, 0.14);
      animation: newCardPulse 1.2s var(--ease-out-expo) 2;
    }
    .post-media-btn {
      border: none;
      padding: 0;
      margin: 0;
      background: transparent;
      width: 100%;
      height: 100%;
      cursor: zoom-in;
      overflow: hidden;
      position: relative;
    }
    .post-media-btn::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.3) 100%);
      opacity: 0;
      transition: opacity var(--dur-fast) ease;
      pointer-events: none;
    }
    .post-card:hover .post-media-btn::after { opacity: 1; }
    .post-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: var(--line-subtle);
      transition: transform var(--dur-slow) var(--ease-out-expo);
    }
    .post-card:hover img {
      transform: scale(1.04);
    }
    .post-copy {
      padding: var(--sp-3);
      display: grid;
      gap: var(--sp-1);
    }
    .post-copy .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      font-weight: 600;
    }
    .post-copy .top-left {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .post-copy .title {
      margin: 0;
      font-size: var(--text-sm);
      line-height: 1.3;
      color: var(--ink);
      text-transform: none;
      letter-spacing: -0.005em;
      font-weight: 700;
    }
    .post-copy .prompt {
      margin: 0;
      font-size: var(--text-xs);
      line-height: 1.45;
      color: var(--muted);
      font-family: var(--mono);
      min-height: 36px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .post-copy .agent-note {
      margin: 0;
      font-size: var(--text-xs);
      line-height: 1.4;
      color: var(--accent-strong);
      font-family: var(--sans);
      font-weight: 600;
      font-style: italic;
    }
    .post-copy .meta-row {
      display: flex;
      justify-content: space-between;
      gap: var(--sp-2);
      align-items: center;
      font-size: var(--text-xs);
      color: var(--faint);
      font-family: var(--mono);
    }
    .post-detail {
      max-height: 0;
      overflow: hidden;
      transition: max-height var(--dur-normal) var(--ease-out-expo), opacity var(--dur-fast) ease;
      opacity: 0;
    }
    .post-card:hover .post-detail,
    .post-card:focus-within .post-detail {
      max-height: 120px;
      opacity: 1;
    }
    .token-row {
      font-size: var(--text-2xs);
      color: var(--faint);
      font-family: var(--mono);
      border-top: 1px dashed var(--line);
      padding-top: var(--sp-1);
      margin-top: var(--sp-1);
      word-break: break-word;
      line-height: 1.4;
    }

    /* ─── Trade cycles ─── */
    .trade-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--sp-3);
    }
    .trade-card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-elevated);
      padding: var(--sp-3);
      display: grid;
      gap: var(--sp-2);
      position: relative;
    }
    .trade-card.clickable {
      cursor: pointer;
      transition: all var(--dur-fast) var(--ease-out-expo);
    }
    .trade-card.clickable:hover {
      transform: translateY(-2px);
      border-color: color-mix(in oklab, var(--accent) 40%, var(--line));
      box-shadow: 0 8px 24px var(--accent-glow);
    }
    .trade-card.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-glow-strong), 0 8px 24px var(--accent-glow);
    }
    .trade-card.is-new {
      border-color: color-mix(in oklab, var(--accent) 65%, var(--line));
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--accent) 35%, transparent), 0 10px 24px rgba(13, 148, 136, 0.16);
      animation: newCardPulse 1.2s var(--ease-out-expo) 2;
    }
    .trade-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), var(--warm));
      border-radius: var(--radius) var(--radius) 0 0;
    }
    .trade-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2);
    }
    .trade-head-right {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .trade-head code {
      font-family: var(--mono);
      font-size: var(--text-xs);
      font-weight: 600;
      color: var(--ink-secondary);
    }
    .trade-meta {
      font-size: var(--text-xs);
      color: var(--faint);
      font-family: var(--mono);
    }
    .trade-rows {
      display: grid;
      gap: var(--sp-2);
    }
    .trade-row {
      display: grid;
      grid-template-columns: minmax(0, 88px) minmax(0, 1fr) 28px minmax(0, 1fr);
      gap: var(--sp-2);
      align-items: stretch;
    }
    .trade-actor {
      border: 1px solid var(--line-subtle);
      border-radius: var(--radius-sm);
      padding: var(--sp-2) var(--sp-1);
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-size: var(--text-xs);
      font-weight: 700;
      color: var(--ink-secondary);
      background: linear-gradient(135deg, #f8fafb, #fafbfc);
      font-family: var(--mono);
      word-break: break-word;
    }
    .trade-item {
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      overflow: hidden;
      display: grid;
      grid-template-rows: 80px auto;
      background: var(--surface-strong);
    }
    .trade-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: var(--line-subtle);
    }
    .trade-item-copy {
      padding: var(--sp-2);
      display: grid;
      gap: 3px;
      font-size: var(--text-2xs);
      color: var(--muted);
      font-family: var(--mono);
    }
    .trade-item-copy strong {
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      line-height: 1.25;
      font-family: var(--sans);
      font-weight: 700;
    }
    .trade-arrow {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
      font-weight: 700;
    }
    .trade-arrow svg {
      width: 20px;
      height: 20px;
    }

    /* ─── Tables ─── */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    th, td {
      border-top: 1px solid var(--line-subtle);
      padding: var(--sp-2);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
      border-top: none;
    }
    td code {
      font-family: var(--mono);
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      word-break: break-all;
    }

    /* ─── Badges ─── */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: var(--text-2xs);
      font-family: var(--mono);
      border: 1px solid var(--line);
      color: var(--ink-secondary);
      background: var(--surface);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 500;
      white-space: nowrap;
    }
    .badge.active { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 30%, var(--line)); background: var(--ok-subtle); }
    .badge.idle { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 30%, var(--line)); background: var(--warn-subtle); }
    .badge.stale, .badge.unseen { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 30%, var(--line)); background: var(--bad-subtle); }
    .badge.settled { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 30%, var(--line)); background: var(--ok-subtle); }
    .badge.executing { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 30%, var(--line)); background: var(--warn-subtle); }
    .badge.proposed { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 30%, var(--line)); background: var(--accent-glow); }
    .badge.pending { color: #0369a1; border-color: color-mix(in oklab, #0369a1 30%, var(--line)); background: rgba(3, 105, 161, 0.08); }
    .badge.failed { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 30%, var(--line)); background: var(--bad-subtle); }
    .badge.new {
      color: #0f766e;
      border-color: color-mix(in oklab, var(--accent) 45%, var(--line));
      background: color-mix(in oklab, var(--accent-glow) 70%, #ffffff);
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .badge.fresh {
      color: #0b7285;
      border-color: color-mix(in oklab, #0b7285 35%, var(--line));
      background: rgba(11, 114, 133, 0.08);
    }
    .badge.seen {
      color: var(--warm);
      border-color: color-mix(in oklab, var(--warm) 40%, var(--line));
      background: var(--warm-glow);
    }
    .badge.listed {
      color: var(--ok);
      border-color: color-mix(in oklab, var(--ok) 32%, var(--line));
      background: var(--ok-subtle);
    }
    .badge.unlisted {
      color: var(--muted);
      border-color: var(--line);
      background: var(--surface);
    }
    .inspector-kind {
      font-weight: 700;
      letter-spacing: 0.08em;
    }
    .inspector-kind.is-none {
      color: var(--muted);
      border-color: var(--line);
      background: var(--surface);
    }
    .inspector-kind.is-post {
      color: #0b7285;
      border-color: color-mix(in oklab, #0b7285 35%, var(--line));
      background: rgba(11, 114, 133, 0.1);
    }
    .inspector-kind.is-edge {
      color: #7c3aed;
      border-color: color-mix(in oklab, #7c3aed 35%, var(--line));
      background: rgba(124, 58, 237, 0.1);
    }
    .inspector-kind.is-match {
      color: var(--ok);
      border-color: color-mix(in oklab, var(--ok) 35%, var(--line));
      background: var(--ok-subtle);
    }

    /* ─── Activity feed ─── */
    .feed {
      display: grid;
      gap: var(--sp-2);
      max-height: 380px;
      overflow-y: auto;
      padding-right: var(--sp-1);
      scrollbar-width: thin;
      scrollbar-color: var(--line) transparent;
    }
    .feed::-webkit-scrollbar { width: 5px; }
    .feed::-webkit-scrollbar-track { background: transparent; }
    .feed::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
    .feed-item {
      border: 1px solid var(--line-subtle);
      border-left: 3px solid var(--line);
      border-radius: 2px var(--radius-sm) var(--radius-sm) 2px;
      padding: var(--sp-2) var(--sp-3);
      background: var(--surface-elevated);
      display: grid;
      gap: 2px;
      transition: border-left-color var(--dur-fast) ease, background var(--dur-fast) ease;
    }
    .feed-item:hover {
      background: color-mix(in oklab, var(--accent-glow) 30%, var(--surface-elevated));
    }
    .feed-item.ev-cycle { border-left-color: var(--accent); }
    .feed-item.ev-settlement { border-left-color: var(--warm); }
    .feed-item.ev-receipt { border-left-color: var(--ok); }
    .feed-item.ev-intent { border-left-color: #8b5cf6; }
    .feed-item .row-a {
      font-size: var(--text-xs);
      color: var(--ink-secondary);
      display: flex;
      justify-content: space-between;
      gap: var(--sp-2);
      align-items: baseline;
      font-weight: 500;
    }
    .feed-item .row-a strong {
      font-weight: 600;
    }
    .feed-item .row-a .feed-time {
      color: var(--faint);
      font-family: var(--mono);
      font-size: var(--text-2xs);
      white-space: nowrap;
    }
    .feed-item .row-b {
      font-size: var(--text-2xs);
      color: var(--faint);
      font-family: var(--mono);
      word-break: break-word;
      line-height: 1.45;
    }

    /* ─── Empty states ─── */
    .empty {
      color: var(--faint);
      font-size: var(--text-sm);
      padding: var(--sp-4);
      text-align: center;
      font-style: italic;
    }

    /* ─── Lightbox ─── */
    .lightbox {
      position: fixed;
      inset: 0;
      background: rgba(9, 12, 17, 0.65);
      backdrop-filter: blur(16px) saturate(120%);
      -webkit-backdrop-filter: blur(16px) saturate(120%);
      display: none;
      align-items: center;
      justify-content: center;
      padding: var(--sp-6);
      z-index: 60;
    }
    .lightbox.open {
      display: flex;
    }
    .lightbox-card {
      width: min(980px, 94vw);
      max-height: 92vh;
      background: #0a0f18;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.04),
        0 24px 60px rgba(0, 0, 0, 0.5),
        0 8px 20px rgba(0, 0, 0, 0.3);
      display: grid;
      grid-template-rows: auto 1fr;
      animation: lightboxIn var(--dur-normal) var(--ease-out-expo) both;
    }
    .lightbox-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-3);
      padding: var(--sp-3) var(--sp-4);
      color: rgba(255,255,255,0.7);
      font-size: var(--text-xs);
      font-family: var(--mono);
      background: rgba(255,255,255,0.04);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .lightbox-head button {
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.8);
      border-radius: var(--radius-sm);
      cursor: pointer;
      padding: 5px 12px;
      font-family: var(--mono);
      font-size: var(--text-xs);
      font-weight: 500;
      transition: all var(--dur-fast) ease;
    }
    .lightbox-head button:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.2);
    }
    .lightbox-body {
      display: grid;
      place-items: center;
      padding: var(--sp-4);
      background: #060a12;
    }
    .lightbox-body img {
      max-width: 100%;
      max-height: 80vh;
      object-fit: contain;
      border-radius: var(--radius-sm);
    }

    /* ─── Reduced motion ─── */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      .post-card:hover img { transform: none; }
    }

    /* ─── Responsive ─── */
    @media (max-width: 980px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .controls-summary {
        min-width: 0;
        width: 100%;
        justify-content: flex-start;
      }
      .control-status {
        min-width: 0;
        width: 100%;
      }
      .primary-stage {
        --stage-panel-h: auto;
      }
      .primary-stage > .panel {
        min-height: 0;
      }
      .primary-stage { grid-template-columns: 1fr; }
      .live-feeds-grid { grid-template-columns: 1fr; }
      .feeds-panel .live-list { max-height: none; }
      .viz-panel .inspector-body { max-height: none; overflow: visible; }
      .essentials { grid-template-columns: 1fr; }
      .post-grid { grid-template-columns: 1fr; }
      .trade-grid { grid-template-columns: 1fr; }
      .trade-row { grid-template-columns: 1fr; }
      .trade-arrow svg { transform: rotate(90deg); }
      .state-guide { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="header">
      <div>
        <h1 class="title">Swap<span class="title-accent">Graph</span> Live Board</h1>
        <div class="meta" id="meta">Waiting for first snapshot...</div>
      </div>
      <div class="status-pill" id="poll-status"><span class="status-dot"></span>Connecting</div>
    </section>

    <section class="panel">
      <div class="panel-head controls-bar">
        <div class="controls-summary">
          <h2>Live Controls</h2>
          <p class="trigger-status control-status" id="control-status">Wave idle.</p>
        </div>
        <div class="controls-right">
          <label class="toggle-pill">Mode
            <select id="trigger-mode" class="feed-select">
              <option value="balanced">Balanced</option>
              <option value="multihop">Multi-hop</option>
            </select>
          </label>
          <label class="toggle-pill">Cadence
            <input id="cadence-seconds" class="cadence-input" type="number" min="5" max="3600" step="1" value="30" aria-label="Cadence seconds">
            <span>s</span>
          </label>
          <button id="trigger-wave" class="trigger-btn" type="button">Run Wave Now</button>
          <button id="cadence-toggle" class="trigger-btn" type="button">Start Cadence</button>
        </div>
      </div>
      <details class="advanced-controls">
        <summary>Advanced setup</summary>
        <div class="advanced-controls-body">
          <div class="controls-right">
            <label class="toggle-pill"><input id="workspace-only-toggle" type="checkbox" checked>Only workspace actors</label>
            <label class="toggle-pill">Wave
              <select id="wave-phase" class="feed-select">
                <option value="match">Post + Match</option>
                <option value="post">Post Only</option>
                <option value="settle">Full Settle</option>
              </select>
            </label>
            <button id="trigger-cycle" class="trigger-btn" type="button">Start New Agent Cycle</button>
          </div>
        </div>
      </details>
    </section>
    <section class="primary-stage">
      <section class="panel feeds-panel">
        <div class="panel-head">
          <h2>Live Feeds</h2>
          <div class="controls-right">
            <label class="toggle-pill">Left
              <select id="feed-left-kind" class="feed-select">
                <option value="posts">Posts</option>
                <option value="edges">Edges</option>
                <option value="matches">Matches</option>
              </select>
            </label>
            <label class="toggle-pill">Right
              <select id="feed-right-kind" class="feed-select">
                <option value="matches">Matches</option>
                <option value="edges">Edges</option>
                <option value="posts">Posts</option>
              </select>
            </label>
          </div>
        </div>
        <div class="live-feeds-grid">
          <section class="live-feed-column">
            <div class="live-feed-title" id="feed-left-title">Posts coming through</div>
            <div class="live-list" id="feed-left-list"></div>
          </section>
          <section class="live-feed-column">
            <div class="live-feed-title" id="feed-right-title">Matches found</div>
            <div class="live-list" id="feed-right-list"></div>
          </section>
        </div>
      </section>
      <section class="panel viz-panel">
        <div class="panel-head">
          <h2>Visualization</h2>
          <div class="controls-right">
            <span class="badge inspector-kind is-none" id="inspector-title">No Selection</span>
            <button id="inspector-close" class="trigger-btn" type="button">Clear</button>
          </div>
        </div>
        <div class="inspector-cycle-graph-wrap" id="inspector-cycle-graph-wrap" hidden>
          <div class="cycle-graph-shell">
            <svg id="cycle-graph" class="cycle-graph" viewBox="0 0 520 240" role="img" aria-label="Selected match cycle graph"></svg>
            <div class="cycle-sub" id="cycle-graph-meta">Select a match to render graph.</div>
          </div>
        </div>
        <div class="inspector-body" id="inspector-body">
          <div class="live-empty">Click any post, edge, or match from either feed to inspect details.</div>
        </div>
      </section>
    </section>
  </main>

  <div id="lightbox" class="lightbox" aria-hidden="true">
    <div class="lightbox-card">
      <div class="lightbox-head">
        <span id="lightbox-title">Preview</span>
        <button id="lightbox-close" type="button">Close</button>
      </div>
      <div class="lightbox-body">
        <img id="lightbox-image" alt="Expanded post preview" loading="lazy">
      </div>
    </div>
  </div>

  <script>
    const byId = id => document.getElementById(id);
    const quickStats = byId('quick-stats');
    const cycleGraph = byId('cycle-graph');
    const cycleGraphMeta = byId('cycle-graph-meta');
    const postsGrid = byId('posts-grid');
    const tradeCyclesGrid = byId('trade-cycles-grid');
    const feed = byId('feed');
    const feedLeftList = byId('feed-left-list');
    const feedRightList = byId('feed-right-list');
    const feedLeftTitle = byId('feed-left-title');
    const feedRightTitle = byId('feed-right-title');
    const feedLeftKindSelect = byId('feed-left-kind');
    const feedRightKindSelect = byId('feed-right-kind');
    const inspectorTitle = byId('inspector-title');
    const inspectorBody = byId('inspector-body');
    const inspectorClose = byId('inspector-close');
    const inspectorCycleGraphWrap = byId('inspector-cycle-graph-wrap');
    const meta = byId('meta');
    const pollStatus = byId('poll-status');
    const triggerCycleButton = byId('trigger-cycle');
    const triggerWaveButton = byId('trigger-wave');
    const cadenceToggleButton = byId('cadence-toggle');
    const triggerModeSelect = byId('trigger-mode');
    const wavePhaseSelect = byId('wave-phase');
    const cadenceSecondsInput = byId('cadence-seconds');
    const workspaceOnlyToggle = byId('workspace-only-toggle');
    const controlStatus = byId('control-status');
    const lightbox = byId('lightbox');
    const lightboxImage = byId('lightbox-image');
    const lightboxTitle = byId('lightbox-title');
    const lightboxClose = byId('lightbox-close');
    let selectedCycleId = null;
    let selectedFeedEntryKey = null;
    let feedEntryMap = new Map();
    let latestTradeCycles = [];
    let tradedAssetIds = new Set();
    let seenPostIds = new Set();
    let seenCycleIds = new Set();
    let newPostIds = new Set();
    let newCycleIds = new Set();
    let hasInitialSnapshot = false;
    let cadenceTimer = null;
    let cadenceTick = 0;
    let cadenceInFlight = false;
    let latestSnapshot = null;
    let inspectorBodyTransitionTimer = null;

    function esc(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function shortAgo(iso) {
      if (!iso) return 'n/a';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return iso;
      const delta = Date.now() - ms;
      if (delta < 0) return 'just now';
      if (delta < 60_000) return Math.floor(delta / 1000) + 's ago';
      if (delta < 3_600_000) return Math.floor(delta / 60_000) + 'm ago';
      if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + 'h ago';
      return Math.floor(delta / 86_400_000) + 'd ago';
    }

    function recencyTierClass(iso) {
      if (!iso) return 'tier-stale';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return 'tier-stale';
      const delta = Date.now() - ms;
      if (delta < 0) return 'tier-hot';
      if (delta < 30_000) return 'tier-hot';
      if (delta < 60_000) return 'tier-fresh';
      if (delta < 300_000) return 'tier-warm';
      return 'tier-stale';
    }

    function normalizeState(value) {
      return String(value || 'proposed').toLowerCase();
    }

    function classifyTradeState(value) {
      const lower = normalizeState(value);
      if (lower === 'completed' || lower === 'settled') {
        return { className: 'settled', label: 'completed', explainer: 'receipt minted, balances finalized' };
      }
      if (lower === 'failed') {
        return { className: 'failed', label: 'failed', explainer: 'cycle closed and legs released/refunded' };
      }
      if (lower === 'executing') {
        return { className: 'executing', label: 'executing', explainer: 'fulfillment and delivery in progress' };
      }
      if (lower.startsWith('escrow.')) {
        return { className: 'pending', label: lower.replace('escrow.', 'escrow '), explainer: 'waiting on escrow/deposit confirmations' };
      }
      return { className: 'proposed', label: 'proposed', explainer: 'candidate cycle waiting for accepts' };
    }

    function titleCaseCompact(value) {
      const text = String(value || '').trim();
      if (!text) return 'unknown';
      return text
        .replaceAll('_', ' ')
        .split(/\s+/g)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }

    function buildTradedAssetIds(cycles) {
      const out = new Set();
      for (const cycle of Array.isArray(cycles) ? cycles : []) {
        for (const participant of Array.isArray(cycle?.participants) ? cycle.participants : []) {
          const giveId = participant?.gives?.asset_id;
          const getId = participant?.gets?.asset_id;
          if (typeof giveId === 'string' && giveId.trim()) out.add(giveId.trim());
          if (typeof getId === 'string' && getId.trim()) out.add(getId.trim());
        }
      }
      return out;
    }

    function parseBooleanParam(value, fallback) {
      if (typeof value !== 'string') return fallback;
      const normalized = value.trim().toLowerCase();
      if (!normalized) return fallback;
      if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
      if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
      return fallback;
    }

    function isWorkspaceOnlyEnabled(searchParams) {
      const raw = searchParams.get('workspace_only');
      if (raw === null) return true;
      return parseBooleanParam(raw, true);
    }

    function syncLocationSearch(searchParams) {
      const next = searchParams.toString();
      const current = window.location.search.startsWith('?')
        ? window.location.search.slice(1)
        : window.location.search;
      if (next === current) return;
      const nextUrl = window.location.pathname + (next ? ('?' + next) : '');
      window.history.replaceState(null, '', nextUrl);
    }

    function renderQuickStats(funnel, snapshot) {
      if (!quickStats) return;
      const rows = [
        { label: 'open listings', value: Number.isFinite(funnel?.intents_active) ? funnel.intents_active : 0 },
        { label: 'proposed cycles', value: Number.isFinite(funnel?.proposals_open) ? funnel.proposals_open : 0 },
        { label: 'settled cycles', value: Number.isFinite(funnel?.timelines_completed) ? funnel.timelines_completed : 0 },
        { label: 'matching runs', value: Array.isArray(snapshot?.matching_runs) ? snapshot.matching_runs.length : 0 }
      ];
      quickStats.innerHTML = rows.map(row => (
        '<span class="quick-pill"><strong>' + esc(row.value) + '</strong><span>' + esc(row.label) + '</span></span>'
      )).join('');
    }

    function renderPosts(rows) {
      if (!rows || rows.length === 0) {
        postsGrid.innerHTML = '<div class="empty">No creative posts yet. Trigger a cycle to generate one.</div>';
        return;
      }
      postsGrid.innerHTML = rows.map(row => {
        const imageTitle = row.title ?? row.intent_id ?? 'post';
        const image = row.image_url
          ? '<button class="post-media-btn" type="button" data-expand-image="1" data-image-url="' + esc(row.image_url) + '" data-image-title="' + esc(imageTitle) + '">'
            + '<img src="' + esc(row.image_url) + '" alt="' + esc(imageTitle) + '" loading="lazy">'
            + '</button>'
          : '<img alt="No preview" loading="lazy">';
        const value = Number.isFinite(row.value_usd) ? '$' + row.value_usd : 'n/a';
        const actor = row.actor_id ? row.actor_id : 'unknown';
        const posted = row.posted_at ? shortAgo(row.posted_at) : 'n/a';
        const novelty = Number.isFinite(row.novelty_score) ? ('Novelty ' + row.novelty_score) : 'Novelty n/a';
        const tags = Array.isArray(row.style_tags) && row.style_tags.length > 0 ? row.style_tags.join(' · ') : null;
        const agentNote = row.agent_message ? row.agent_message : null;
        const capability = row.delivery_capability_token ?? null;
        const postKey = (typeof row.intent_id === 'string' && row.intent_id.trim())
          ? row.intent_id.trim()
          : (typeof row.asset_id === 'string' && row.asset_id.trim() ? row.asset_id.trim() : null);
        const isNew = postKey ? newPostIds.has(postKey) : false;
        const hasTradedHistory = typeof row.asset_id === 'string' && row.asset_id.trim()
          ? tradedAssetIds.has(row.asset_id.trim())
          : false;
        const listingStatus = String(row.status || 'unknown').toLowerCase();
        const listedClass = listingStatus === 'active' ? 'listed' : 'unlisted';
        const listedLabel = listingStatus === 'active' ? 'listed now' : titleCaseCompact(listingStatus);
        const historyClass = hasTradedHistory ? 'seen' : 'fresh';
        const historyLabel = hasTradedHistory ? 'seen in cycle' : 'new to market';
        const tokenBits = [];
        if (capability?.token_id) tokenBits.push(capability.token_id);
        if (capability?.delivery_target) tokenBits.push(capability.delivery_target);
        if (capability?.expires_at) tokenBits.push('exp ' + shortAgo(capability.expires_at));
        const tokenRow = tokenBits.length > 0 ? ('<div class="token-row">capability: ' + esc(tokenBits.join(' • ')) + '</div>') : '';
        return '<article class="post-card' + (isNew ? ' is-new' : '') + '">'
          + image
          + '<div class="post-copy">'
          + '<div class="top"><div class="top-left"><span class="badge">' + esc(actor) + '</span>'
          + '<span class="badge ' + esc(listedClass) + '">' + esc(listedLabel) + '</span>'
          + '<span class="badge ' + esc(historyClass) + '">' + esc(historyLabel) + '</span>'
          + (isNew ? '<span class="badge new">NEW</span>' : '')
          + '</div><span>' + esc(posted) + '</span></div>'
          + '<p class="title">' + esc(row.title ?? row.intent_id ?? 'Untitled') + '</p>'
          + '<p class="prompt">' + esc(row.prompt_spec ?? 'No prompt provided') + '</p>'
          + (agentNote ? ('<p class="agent-note">"' + esc(agentNote) + '"</p>') : '')
          + '<div class="meta-row"><span>' + esc(row.deliverable_type ?? 'deliverable') + '</span><span>' + esc(value) + '</span></div>'
          + '<div class="post-detail">'
          + '<div class="meta-row"><span>' + esc(novelty) + '</span><span>' + esc(tags ?? '') + '</span></div>'
          + tokenRow
          + '</div>'
          + '</div>'
          + '</article>';
      }).join('');
    }

    function openLightbox({ imageUrl, title }) {
      if (!lightbox || !lightboxImage || !lightboxTitle) return;
      if (!imageUrl) return;
      lightboxImage.src = imageUrl;
      lightboxTitle.textContent = title || 'Preview';
      lightbox.classList.add('open');
      lightbox.setAttribute('aria-hidden', 'false');
    }

    function closeLightbox() {
      if (!lightbox || !lightboxImage) return;
      lightbox.classList.remove('open');
      lightbox.setAttribute('aria-hidden', 'true');
      lightboxImage.removeAttribute('src');
    }

    function renderTradeCycles(rows) {
      if (!rows || rows.length === 0) {
        tradeCyclesGrid.innerHTML = '<div class="empty">No cycles yet. Trigger a cycle to watch the trade legs.</div>';
        return;
      }
      tradeCyclesGrid.innerHTML = rows.map(cycle => {
        const state = cycle.state || 'proposed';
        const stateSummary = classifyTradeState(state);
        const receipt = cycle.receipt_id ? ('receipt ' + cycle.receipt_id) : 'no receipt yet';
        const updated = cycle.updated_at ? shortAgo(cycle.updated_at) : 'n/a';
        const cycleId = cycle.cycle_id || '';
        const isActive = cycleId && cycleId === selectedCycleId;
        const isNew = cycleId ? newCycleIds.has(cycleId) : false;
        const participantRows = (cycle.participants || []).map(participant => {
          const gives = participant.gives || {};
          const gets = participant.gets || {};
          const giveValue = Number.isFinite(gives.value_usd) ? ('$' + gives.value_usd) : 'n/a';
          const getValue = Number.isFinite(gets.value_usd) ? ('$' + gets.value_usd) : 'n/a';
          return '<div class="trade-row">'
            + '<div class="trade-actor">' + esc(participant.actor_id || 'actor') + '</div>'
            + '<div class="trade-item">'
            + (gives.image_url ? '<img src="' + esc(gives.image_url) + '" alt="' + esc(gives.title || gives.asset_id || 'give asset') + '" loading="lazy">' : '<img alt="no give image" loading="lazy">')
            + '<div class="trade-item-copy"><span>Gives</span><strong>' + esc(gives.title || gives.asset_id || 'asset') + '</strong><span>' + esc((gives.deliverable_type || 'asset') + ' • ' + giveValue) + '</span></div>'
            + '</div>'
            + '<div class="trade-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>'
            + '<div class="trade-item">'
            + (gets.image_url ? '<img src="' + esc(gets.image_url) + '" alt="' + esc(gets.title || gets.asset_id || 'get asset') + '" loading="lazy">' : '<img alt="no get image" loading="lazy">')
            + '<div class="trade-item-copy"><span>Gets</span><strong>' + esc(gets.title || gets.asset_id || 'asset') + '</strong><span>' + esc((gets.deliverable_type || 'asset') + ' • ' + getValue) + '</span></div>'
            + '</div>'
            + '</div>';
        }).join('');
        return '<article class="trade-card clickable' + (isActive ? ' active' : '') + (isNew ? ' is-new' : '') + '" data-cycle-id="' + esc(cycleId) + '" role="button" tabindex="0" aria-label="Focus cycle ' + esc(cycleId || 'cycle') + '">'
          + '<div class="trade-head"><code>' + esc(cycle.cycle_id || 'cycle') + '</code><div class="trade-head-right"><span class="badge ' + esc(stateSummary.className) + '">' + esc(stateSummary.label) + '</span>' + (isNew ? '<span class="badge new">NEW</span>' : '') + '</div></div>'
          + '<div class="trade-meta">' + esc(receipt + ' • updated ' + updated + ' • ' + stateSummary.explainer) + '</div>'
          + '<div class="trade-rows">' + participantRows + '</div>'
          + '</article>';
      }).join('');
    }

    function renderCycleGraph(rows) {
      if (!cycleGraph || !cycleGraphMeta) return;
      if (!rows || rows.length === 0) {
        selectedCycleId = null;
        cycleGraph.innerHTML = '';
        cycleGraphMeta.textContent = 'No cycle yet. Trigger one to watch actor flows.';
        return;
      }
      let cycle = null;
      if (selectedCycleId) {
        cycle = rows.find(row => row?.cycle_id === selectedCycleId) ?? null;
      }
      if (!cycle) {
        cycle = rows[0] ?? null;
        selectedCycleId = cycle?.cycle_id ?? null;
      }
      const participants = Array.isArray(cycle?.participants) ? cycle.participants : [];
      const actorIds = Array.from(new Set(participants.map(row => String(row?.actor_id ?? '').trim()).filter(Boolean)));
      if (actorIds.length < 2) {
        cycleGraph.innerHTML = '';
        cycleGraphMeta.textContent = 'Cycle has insufficient participants to render graph.';
        return;
      }
      const w = 520;
      const h = 240;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.33;
      const points = actorIds.map((actorId, idx) => {
        const angle = (-Math.PI / 2) + ((Math.PI * 2 * idx) / actorIds.length);
        return {
          actor_id: actorId,
          x: cx + (Math.cos(angle) * radius),
          y: cy + (Math.sin(angle) * radius)
        };
      });
      const pointByActorId = new Map(points.map(point => [point.actor_id, point]));
      const edges = [];
      const edgeSet = new Set();
      const addEdge = (from, to) => {
        const a = String(from ?? '').trim();
        const b = String(to ?? '').trim();
        if (!a || !b || a === b) return;
        const key = a + '>' + b;
        if (edgeSet.has(key)) return;
        edgeSet.add(key);
        edges.push({ from: a, to: b });
      };

      for (const participant of participants) {
        const actorId = String(participant?.actor_id ?? '').trim();
        if (!actorId) continue;
        const givesAssetId = participant?.gives?.asset_id ? String(participant.gives.asset_id) : null;
        const getsAssetId = participant?.gets?.asset_id ? String(participant.gets.asset_id) : null;

        if (givesAssetId) {
          const consumer = participants.find(candidate => {
            const candidateActorId = String(candidate?.actor_id ?? '').trim();
            const candidateGetsAssetId = candidate?.gets?.asset_id ? String(candidate.gets.asset_id) : null;
            return candidateActorId !== actorId && candidateGetsAssetId && candidateGetsAssetId === givesAssetId;
          });
          if (consumer) addEdge(actorId, consumer?.actor_id);
        }

        if (getsAssetId) {
          const provider = participants.find(candidate => {
            const candidateActorId = String(candidate?.actor_id ?? '').trim();
            const candidateGivesAssetId = candidate?.gives?.asset_id ? String(candidate.gives.asset_id) : null;
            return candidateActorId !== actorId && candidateGivesAssetId && candidateGivesAssetId === getsAssetId;
          });
          if (provider) addEdge(provider?.actor_id, actorId);
        }
      }

      if (edges.length === 0) {
        for (let idx = 0; idx < actorIds.length; idx += 1) {
          const from = actorIds[idx];
          const to = actorIds[(idx + 1) % actorIds.length];
          addEdge(from, to);
        }
      }
      if (actorIds.length === 2 && edges.length === 1) {
        addEdge(edges[0].to, edges[0].from);
      }

      const markerDefs = '<defs>'
        + '<marker id="cycle-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon class="cycle-arrow" points="0 0, 10 3.5, 0 7"></polygon></marker>'
        + '<filter id="edgeGlow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
        + '<filter id="nodeGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
        + '</defs>';
      const edgeSvg = edges.map((edge, idx) => {
        const fromPoint = pointByActorId.get(edge.from);
        const toPoint = pointByActorId.get(edge.to);
        if (!fromPoint || !toPoint) return '';
        const reciprocalKey = edge.to + '>' + edge.from;
        const hasReciprocal = edgeSet.has(reciprocalKey);
        const dx = toPoint.x - fromPoint.x;
        const dy = toPoint.y - fromPoint.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / dist;
        const uy = dy / dist;
        const trim = 26;
        const sx = fromPoint.x + (ux * trim);
        const sy = fromPoint.y + (uy * trim);
        const ex = toPoint.x - (ux * trim);
        const ey = toPoint.y - (uy * trim);
        let d = 'M ' + sx.toFixed(2) + ' ' + sy.toFixed(2) + ' L ' + ex.toFixed(2) + ' ' + ey.toFixed(2);
        if (hasReciprocal && actorIds.length === 2) {
          const nx = -uy;
          const ny = ux;
          const sign = String(edge.from).localeCompare(String(edge.to)) <= 0 ? 1 : -1;
          const curvature = 34 * sign;
          const mx = (sx + ex) / 2;
          const my = (sy + ey) / 2;
          const cxCtrl = mx + (nx * curvature);
          const cyCtrl = my + (ny * curvature);
          d = 'M ' + sx.toFixed(2) + ' ' + sy.toFixed(2) + ' Q ' + cxCtrl.toFixed(2) + ' ' + cyCtrl.toFixed(2) + ' ' + ex.toFixed(2) + ' ' + ey.toFixed(2);
        }
        return '<path class="cycle-edge" d="' + d + '" marker-end="url(#cycle-arrowhead)" style="animation-delay:' + (idx * 0.18).toFixed(2) + 's"></path>';
      }).join('');
      const nodeSvg = points.map(point => {
        return '<g>'
          + '<circle class="cycle-node" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="22"></circle>'
          + '<text class="cycle-label" x="' + point.x.toFixed(2) + '" y="' + (point.y + 4).toFixed(2) + '">' + esc(point.actor_id) + '</text>'
          + '</g>';
      }).join('');
      cycleGraph.innerHTML = markerDefs + edgeSvg + nodeSvg;
      const state = cycle?.state ? cycle.state : 'proposed';
      const stateSummary = classifyTradeState(state);
      cycleGraphMeta.textContent = 'Cycle ' + (cycle?.cycle_id ?? 'n/a') + ' • ' + stateSummary.label + ' • ' + actorIds.length + '-actor flow • ' + stateSummary.explainer;
    }

    function renderFeed(rows) {
      if (!rows || rows.length === 0) {
        feed.innerHTML = '<div class="empty">No events yet.</div>';
        return;
      }
      feed.innerHTML = rows.map(row => {
        const actor = row.actor_id ? row.actor_type + ':' + row.actor_id : 'system';
        const cycle = row.cycle_id ? 'cycle=' + row.cycle_id : '';
        const intent = row.intent_id ? ' intent=' + row.intent_id : '';
        const evType = String(row.type || '');
        let evClass = '';
        if (evType.startsWith('cycle.')) evClass = ' ev-cycle';
        else if (evType.startsWith('settlement.')) evClass = ' ev-settlement';
        else if (evType.startsWith('receipt.')) evClass = ' ev-receipt';
        else if (evType.startsWith('intent.')) evClass = ' ev-intent';
        return '<article class="feed-item' + evClass + '">'
          + '<div class="row-a"><strong>' + esc(row.type) + '</strong><span class="feed-time">' + esc(shortAgo(row.occurred_at)) + '</span></div>'
          + '<div class="row-b">' + esc(actor) + (cycle || intent ? ' • ' + esc(cycle + intent) : '') + '</div>'
          + '<div class="row-b">' + esc(row.summary ?? '') + '</div>'
          + '</article>';
      }).join('');
    }

    function normalizeFeedKind(value, fallback = 'posts') {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'products') return 'posts';
      if (raw === 'intents') return 'edges';
      if (raw === 'cycles') return 'matches';
      if (raw === 'posts' || raw === 'edges' || raw === 'matches') return raw;
      return fallback;
    }

    function feedTitleForKind(kind) {
      if (kind === 'edges') return 'Edges being placed';
      if (kind === 'matches') return 'Matches found';
      return 'Posts coming through';
    }

    function formatUsd(value) {
      return Number.isFinite(value) ? ('$' + value) : 'n/a';
    }

    function entryKeyForRow(row, idx) {
      const baseId = row?.id ? String(row.id) : ('row_' + idx);
      return String(row?.entry_key || (String(row?.kind || 'item') + ':' + baseId));
    }

    function buildEdgeRows(posts) {
      const safePosts = Array.isArray(posts) ? posts : [];
      const byAssetId = new Map();
      for (const post of safePosts) {
        const assetId = typeof post?.asset_id === 'string' ? post.asset_id.trim() : '';
        if (!assetId || byAssetId.has(assetId)) continue;
        byAssetId.set(assetId, post);
      }
      const rows = [];
      const seen = new Set();
      for (let idx = 0; idx < safePosts.length; idx += 1) {
        const source = safePosts[idx];
        const sourceKey = source?.intent_id || source?.asset_id || ('post_' + idx);
        const wanted = Array.isArray(source?.wanted_asset_ids)
          ? source.wanted_asset_ids.map(value => String(value || '').trim()).filter(Boolean)
          : [];
        for (const wantedAssetId of wanted) {
          const edgeKey = sourceKey + '->' + wantedAssetId;
          if (seen.has(edgeKey)) continue;
          seen.add(edgeKey);
          const target = byAssetId.get(wantedAssetId) ?? null;
          rows.push({
            kind: 'edges',
            id: edgeKey,
            entry_key: 'edge:' + edgeKey,
            time: source?.posted_at ?? null,
            actor: source?.actor_id ?? 'unknown',
            title: (source?.actor_id ?? 'actor') + ' wants ' + (target?.title ?? wantedAssetId),
            subtitle: target
              ? ('From ' + (target?.actor_id ?? 'unknown') + ': ' + (target?.title ?? target?.asset_id ?? wantedAssetId))
              : ('Target asset not listed yet: ' + wantedAssetId),
            meta: 'offers ' + (source?.title ?? source?.asset_id ?? 'asset')
              + ' • wants '
              + (target?.title ?? wantedAssetId),
            image_url: source?.image_url ?? null,
            source_post: source,
            target_post: target,
            wanted_asset_id: wantedAssetId
          });
        }
      }
      return rows;
    }

    function buildLiveFeedRows(kind, snapshot) {
      const posts = Array.isArray(snapshot?.posts) ? snapshot.posts : [];
      const tradeCycles = Array.isArray(snapshot?.trade_cycles) ? snapshot.trade_cycles : [];
      if (kind === 'posts') {
        return posts.slice(0, 24).map((row, idx) => ({
          kind,
          id: row.intent_id ?? row.asset_id ?? row.title ?? ('post_' + idx),
          entry_key: 'post:' + (row.intent_id ?? row.asset_id ?? String(idx)),
          time: row.posted_at,
          actor: row.actor_id ?? 'unknown',
          title: row.title ?? row.intent_id ?? 'Untitled',
          subtitle: row.prompt_spec ?? '',
          meta: (row.deliverable_type ?? 'deliverable') + ' • ' + formatUsd(row.value_usd),
          image_url: row.image_url ?? null,
          post: row
        }));
      }
      if (kind === 'edges') {
        return buildEdgeRows(posts).slice(0, 24);
      }
      return tradeCycles.slice(0, 24).map((row, idx) => {
        const actors = Array.isArray(row?.participants)
          ? row.participants.map(participant => participant?.actor_id).filter(Boolean).slice(0, 4)
          : [];
        const stateSummary = classifyTradeState(row?.state);
        return {
          kind: 'matches',
          id: row.cycle_id ?? ('cycle_' + idx),
          entry_key: 'match:' + (row.cycle_id ?? String(idx)),
          time: row.updated_at,
          actor: actors.join(' • ') || 'actors',
          title: (row.cycle_id ?? 'cycle') + ' • ' + stateSummary.label,
          subtitle: actors.length > 0 ? actors.join(' → ') : 'participants pending',
          meta: (Number.isFinite(row.participant_count) ? row.participant_count : actors.length) + '-actor cycle'
            + (row.receipt_id ? (' • receipt ' + row.receipt_id) : ''),
          image_url: null,
          cycle: row
        };
      });
    }

    function setInspectorKind(kind, label) {
      if (!inspectorTitle) return;
      inspectorTitle.textContent = label;
      inspectorTitle.classList.remove('is-none', 'is-post', 'is-edge', 'is-match');
      if (kind === 'post') inspectorTitle.classList.add('is-post');
      else if (kind === 'edge') inspectorTitle.classList.add('is-edge');
      else if (kind === 'match') inspectorTitle.classList.add('is-match');
      else inspectorTitle.classList.add('is-none');
    }

    function setInspectorBodyMarkup(markup) {
      if (!inspectorBody) return;
      inspectorBody.classList.add('changing');
      if (inspectorBodyTransitionTimer !== null) window.clearTimeout(inspectorBodyTransitionTimer);
      inspectorBodyTransitionTimer = window.setTimeout(() => {
        if (!inspectorBody) return;
        inspectorBody.innerHTML = markup;
        inspectorBody.classList.remove('changing');
      }, 90);
    }

    function renderInspectorEmpty(text = 'Click any post, edge, or match from either feed to inspect details.') {
      setInspectorKind('none', 'No Selection');
      setInspectorBodyMarkup('<div class="live-empty">' + esc(text) + '</div>');
      if (inspectorCycleGraphWrap) inspectorCycleGraphWrap.hidden = true;
      if (cycleGraph) cycleGraph.innerHTML = '';
      if (cycleGraphMeta) cycleGraphMeta.textContent = 'Select a match to render graph.';
      selectedCycleId = null;
    }

    function renderInspectorMediaCard({ imageUrl, title, label }) {
      const src = typeof imageUrl === 'string' ? imageUrl.trim() : '';
      if (!src) return '';
      const imageTitle = title || label || 'preview';
      return '<figure class="inspector-media-card">'
        + '<button class="inspector-media-btn" type="button" data-expand-image="1" data-image-url="' + esc(src) + '" data-image-title="' + esc(imageTitle) + '">'
        + '<img src="' + esc(src) + '" alt="' + esc(imageTitle) + '" loading="eager" decoding="async" onerror="this.style.display=\\'none\\'; this.parentElement.classList.add(\\'broken\\');">'
        + '</button>'
        + '<figcaption class="inspector-media-label">' + esc(label || 'Preview') + '</figcaption>'
        + '</figure>';
    }

    function renderPostInspector(post) {
      if (!inspectorBody) return;
      const wants = Array.isArray(post?.wanted_asset_ids)
        ? post.wanted_asset_ids.map(value => String(value || '').trim()).filter(Boolean)
        : [];
      const mediaCard = renderInspectorMediaCard({
        imageUrl: post?.image_url ?? null,
        title: post?.title ?? 'post preview',
        label: 'Selected Post'
      });
      const media = mediaCard ? ('<div class="inspector-media-grid">' + mediaCard + '</div>') : '';
      const rows = [
        ['Actor', esc(post?.actor_id ?? 'unknown')],
        ['Title', '<strong>' + esc(post?.title ?? 'Untitled') + '</strong>'],
        ['Trade Request', esc(post?.agent_message ?? post?.prompt_spec ?? 'No request provided')],
        ['Offer', esc((post?.deliverable_type ?? 'deliverable') + ' • ' + formatUsd(post?.value_usd))],
        ['Wants', wants.length > 0 ? wants.map(esc).join(', ') : 'Open request']
      ];
      setInspectorBodyMarkup(media + rows.map(([key, value]) => (
        '<div class="inspector-row"><div class="inspector-key">' + esc(key) + '</div><div class="inspector-value">' + value + '</div></div>'
      )).join(''));
      if (inspectorCycleGraphWrap) inspectorCycleGraphWrap.hidden = true;
      if (cycleGraph) cycleGraph.innerHTML = '';
      if (cycleGraphMeta) cycleGraphMeta.textContent = 'Select a match to render graph.';
      selectedCycleId = null;
    }

    function renderEdgeInspector(entry) {
      if (!inspectorBody) return;
      const source = entry?.source_post ?? {};
      const target = entry?.target_post ?? null;
      const sourceImage = renderInspectorMediaCard({
        imageUrl: source?.image_url ?? null,
        title: source?.title ?? 'source post',
        label: 'From'
      });
      const targetImage = renderInspectorMediaCard({
        imageUrl: target?.image_url ?? null,
        title: target?.title ?? 'target post',
        label: 'Target'
      });
      const sourceTitle = source?.title ?? source?.asset_id ?? 'post';
      const wantedTitle = target?.title ?? entry?.wanted_asset_id ?? 'asset';
      const rows = [
        ['From', '<strong>' + esc(source?.actor_id ?? 'unknown') + '</strong> listed ' + esc(sourceTitle)],
        ['Wants', esc(wantedTitle)],
        ['Target', target
          ? ('<strong>' + esc(target?.actor_id ?? 'unknown') + '</strong> listed ' + esc(target?.title ?? target?.asset_id ?? entry?.wanted_asset_id ?? 'asset'))
          : 'Target not listed yet'],
        ['Edge Logic', esc((source?.actor_id ?? 'source') + ' -> ' + (target?.actor_id ?? 'open market'))]
      ];
      const rawDetails = '<details class="inspector-raw"><summary>Raw IDs</summary>'
        + '<div class="inspector-value"><code>offer_asset=' + esc(source?.asset_id ?? 'n/a') + '</code><br>'
        + '<code>want_asset=' + esc(entry?.wanted_asset_id ?? 'n/a') + '</code>'
        + '</div></details>';
      const media = sourceImage || targetImage
        ? ('<div class="inspector-media-grid">' + sourceImage + targetImage + '</div>')
        : '';
      setInspectorBodyMarkup(media
        + rows.map(([key, value]) => (
          '<div class="inspector-row"><div class="inspector-key">' + esc(key) + '</div><div class="inspector-value">' + value + '</div></div>'
        )).join('')
        + rawDetails);
      if (inspectorCycleGraphWrap) inspectorCycleGraphWrap.hidden = true;
      if (cycleGraph) cycleGraph.innerHTML = '';
      if (cycleGraphMeta) cycleGraphMeta.textContent = 'Select a match to render graph.';
      selectedCycleId = null;
    }

    function renderMatchInspector(cycle) {
      if (!inspectorBody) return;
      const participants = Array.isArray(cycle?.participants) ? cycle.participants : [];
      const stateSummary = classifyTradeState(cycle?.state);
      const legs = participants.map(participant => {
        const gives = participant?.gives ?? {};
        const gets = participant?.gets ?? {};
        return '<div class="inspector-match-leg">'
          + '<strong>' + esc(participant?.actor_id ?? 'actor') + '</strong><br>'
          + 'gives ' + esc(gives?.title ?? gives?.asset_id ?? 'asset') + ' (' + esc(formatUsd(gives?.value_usd)) + ')<br>'
          + 'gets ' + esc(gets?.title ?? gets?.asset_id ?? 'asset') + ' (' + esc(formatUsd(gets?.value_usd)) + ')'
          + '</div>';
      }).join('');
      const rows = [
        ['Cycle', '<code>' + esc(cycle?.cycle_id ?? 'cycle') + '</code>'],
        ['State', esc(stateSummary.label + ' • ' + stateSummary.explainer)],
        ['Updated', esc(shortAgo(cycle?.updated_at))],
        ['Receipt', esc(cycle?.receipt_id ?? 'pending')]
      ];
      setInspectorBodyMarkup(rows.map(([key, value]) => (
        '<div class="inspector-row"><div class="inspector-key">' + esc(key) + '</div><div class="inspector-value">' + value + '</div></div>'
      )).join('') + '<div class="inspector-match-grid">' + (legs || '<div class="live-empty">No participant legs yet.</div>') + '</div>');
      if (inspectorCycleGraphWrap) inspectorCycleGraphWrap.hidden = false;
      selectedCycleId = typeof cycle?.cycle_id === 'string' ? cycle.cycle_id : null;
      renderCycleGraph([cycle]);
    }

    function renderInspectorEntry(entry) {
      if (!entry) {
        renderInspectorEmpty();
        return;
      }
      if (entry.kind === 'posts') {
        setInspectorKind('post', 'Post');
        renderPostInspector(entry.post ?? null);
        return;
      }
      if (entry.kind === 'edges') {
        setInspectorKind('edge', 'Edge');
        renderEdgeInspector(entry);
        return;
      }
      setInspectorKind('match', 'Match');
      renderMatchInspector(entry.cycle ?? null);
    }

    function syncFeedSelectionHighlight() {
      const nodes = document.querySelectorAll('.live-item[data-entry-key]');
      for (const node of nodes) {
        const key = node.getAttribute('data-entry-key');
        node.classList.toggle('active', Boolean(key) && key === selectedFeedEntryKey);
      }
    }

    function openInspectorByEntryKey(entryKey) {
      const key = typeof entryKey === 'string' ? entryKey.trim() : '';
      if (!key) return;
      selectedFeedEntryKey = key;
      renderInspectorEntry(feedEntryMap.get(key) ?? null);
      syncFeedSelectionHighlight();
    }

    function renderLiveFeedColumn({ container, titleNode, kind, snapshot }) {
      if (!container) return { firstEntryKey: null };
      if (titleNode) titleNode.textContent = feedTitleForKind(kind);
      const rows = buildLiveFeedRows(kind, snapshot);
      if (rows.length === 0) {
        container.innerHTML = '<div class="live-empty">No ' + esc(kind) + ' events yet.</div>';
        return { firstEntryKey: null };
      }
      let firstEntryKey = null;
      container.innerHTML = rows.map((row, idx) => {
        const entryKey = entryKeyForRow(row, idx);
        if (!firstEntryKey) firstEntryKey = entryKey;
        feedEntryMap.set(entryKey, row);
        const isActive = entryKey === selectedFeedEntryKey;
        const timeTier = recencyTierClass(row.time);
        const head = '<div class="live-item-head"><span class="badge">' + esc(row.actor || 'actor') + '</span><span class="live-item-time ' + esc(timeTier) + '">' + esc(shortAgo(row.time)) + '</span></div>';
        const copy = '<p class="live-item-title">' + esc(row.title || 'item') + '</p>'
          + (row.subtitle ? ('<p class="live-item-sub">' + esc(row.subtitle) + '</p>') : '')
          + (row.meta ? ('<p class="live-item-meta">' + esc(row.meta) + '</p>') : '');
        const body = row.image_url
          ? ('<div class="live-item-row"><img class="live-thumb" src="' + esc(row.image_url) + '" alt="' + esc(row.title || 'preview') + '" loading="lazy"><div>' + copy + '</div></div>')
          : copy;
        return '<article class="live-item clickable kind-' + esc(row.kind) + (isActive ? ' active' : '') + '" role="button" tabindex="0" data-entry-key="' + esc(entryKey) + '">' + head + body + '</article>';
      }).join('');
      return { firstEntryKey };
    }

    function renderLiveFeeds(snapshot) {
      const leftKind = normalizeFeedKind(feedLeftKindSelect?.value, 'posts');
      const rightKind = normalizeFeedKind(feedRightKindSelect?.value, leftKind === 'matches' ? 'edges' : 'matches');
      if (feedLeftKindSelect && feedLeftKindSelect.value !== leftKind) feedLeftKindSelect.value = leftKind;
      if (feedRightKindSelect && feedRightKindSelect.value !== rightKind) feedRightKindSelect.value = rightKind;
      feedEntryMap = new Map();
      const leftRender = renderLiveFeedColumn({ container: feedLeftList, titleNode: feedLeftTitle, kind: leftKind, snapshot });
      const rightRender = renderLiveFeedColumn({ container: feedRightList, titleNode: feedRightTitle, kind: rightKind, snapshot });
      if (selectedFeedEntryKey && feedEntryMap.has(selectedFeedEntryKey)) {
        renderInspectorEntry(feedEntryMap.get(selectedFeedEntryKey));
      } else {
        let firstMatchEntryKey = null;
        for (const [entryKey, row] of feedEntryMap.entries()) {
          if (row?.kind === 'matches') {
            firstMatchEntryKey = entryKey;
            break;
          }
        }
        selectedFeedEntryKey = firstMatchEntryKey || leftRender.firstEntryKey || rightRender.firstEntryKey || null;
        if (selectedFeedEntryKey) renderInspectorEntry(feedEntryMap.get(selectedFeedEntryKey) ?? null);
        else renderInspectorEmpty('No posts, edges, or matches yet. Run a wave to generate activity.');
      }
      syncFeedSelectionHighlight();
    }

    function setPollStatus(kind, text) {
      pollStatus.className = 'status-pill ' + kind;
      pollStatus.innerHTML = '<span class="status-dot"></span>' + esc(text);
    }

    function setControlStatus(text) {
      if (controlStatus) controlStatus.textContent = text;
    }

    function setTriggerStatus(text) {
      setControlStatus(text);
    }

    function setCadenceStatus(text) {
      setControlStatus(text);
    }

    function selectedMode() {
      return triggerModeSelect?.value === 'multihop' ? 'multihop' : 'balanced';
    }

    function selectedWavePhase() {
      const raw = String(wavePhaseSelect?.value || 'match').toLowerCase();
      if (raw === 'post') return 'post';
      if (raw === 'settle') return 'settle';
      return 'match';
    }

    function selectedFeedKinds() {
      const left = normalizeFeedKind(feedLeftKindSelect?.value, 'posts');
      const right = normalizeFeedKind(feedRightKindSelect?.value, left === 'matches' ? 'edges' : 'matches');
      return { left, right };
    }

    function cadenceIntervalMs() {
      const raw = Number.parseInt(String(cadenceSecondsInput?.value ?? ''), 10);
      const seconds = Number.isFinite(raw) ? Math.max(5, Math.min(3600, raw)) : 30;
      if (cadenceSecondsInput) cadenceSecondsInput.value = String(seconds);
      return seconds * 1000;
    }

    function cadenceRunning() {
      return cadenceTimer !== null;
    }

    function refreshCadenceButton() {
      if (!cadenceToggleButton) return;
      const running = cadenceRunning();
      cadenceToggleButton.textContent = running ? 'Pause Cadence' : 'Start Cadence';
      cadenceToggleButton.classList.toggle('running', running);
    }

    async function triggerWave({ source = 'manual' } = {}) {
      if (cadenceInFlight) return null;
      cadenceInFlight = true;
      if (triggerWaveButton) triggerWaveButton.disabled = true;
      const mode = selectedMode();
      const phase = selectedWavePhase();
      const start = Date.now();
      try {
        const response = await fetch('/demo/live-board/trigger-wave', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({ mode, phase })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) {
          const msg = payload?.error?.message || payload?.error?.code || ('request failed (' + response.status + ')');
          throw new Error(msg);
        }
        const wave = payload?.demo_wave ?? {};
        const createdCount = Array.isArray(wave.created_intents) ? wave.created_intents.length : 0;
        const proposalCount = Number.isFinite(wave.proposal_count)
          ? wave.proposal_count
          : (Array.isArray(wave.proposed_cycles) ? wave.proposed_cycles.length : 0);
        const settledCount = Number.isFinite(wave.cycle_count)
          ? wave.cycle_count
          : (Array.isArray(wave.settled_cycles) ? wave.settled_cycles.length : 0);
        const latency = Date.now() - start;
        setTriggerStatus('Wave: +'
          + createdCount + ' intents • '
          + proposalCount + ' proposed • '
          + settledCount + ' settled • '
          + mode + '/' + phase + ' • '
          + latency + 'ms');
        if (source === 'cadence') {
          const secs = Math.max(1, Math.floor(cadenceIntervalMs() / 1000));
          setCadenceStatus('Cadence running • tick ' + cadenceTick + ' • every ' + secs + 's • mode ' + mode + ' • phase ' + phase);
        }
        await load();
        return wave;
      } catch (error) {
        setTriggerStatus('Wave failed: ' + error.message);
        if (source === 'cadence') setCadenceStatus('Cadence error: ' + error.message);
        return null;
      } finally {
        cadenceInFlight = false;
        if (triggerWaveButton) triggerWaveButton.disabled = false;
      }
    }

    function stopCadence() {
      if (cadenceTimer !== null) {
        window.clearInterval(cadenceTimer);
        cadenceTimer = null;
      }
      refreshCadenceButton();
      setCadenceStatus('Cadence paused.');
    }

    function startCadence() {
      stopCadence();
      cadenceTick = 0;
      const intervalMs = cadenceIntervalMs();
      const seconds = Math.max(1, Math.floor(intervalMs / 1000));
      setCadenceStatus('Cadence starting • every ' + seconds + 's');
      refreshCadenceButton();
      cadenceTimer = window.setInterval(() => {
        cadenceTick += 1;
        void triggerWave({ source: 'cadence' });
      }, intervalMs);
      cadenceTick += 1;
      void triggerWave({ source: 'cadence' });
      refreshCadenceButton();
    }

    async function triggerCycle() {
      if (!triggerCycleButton) return;
      triggerCycleButton.disabled = true;
      const mode = selectedMode();
      setTriggerStatus('Starting new ' + mode + ' cycle...');
      try {
        const response = await fetch('/demo/live-board/trigger-cycle', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({ mode })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok !== true) {
          const msg = payload?.error?.message || payload?.error?.code || ('request failed (' + response.status + ')');
          throw new Error(msg);
        }
        const cycle = payload?.demo_cycle ?? {};
        const firstCycle = Array.isArray(cycle.settled_cycles) ? cycle.settled_cycles[0] : null;
        const cycleCount = Number.isFinite(cycle.cycle_count) ? cycle.cycle_count : (Array.isArray(cycle.settled_cycles) ? cycle.settled_cycles.length : 1);
        const proposalId = cycle.proposal_id || firstCycle?.proposal_id || 'n/a';
        const receiptId = cycle.receipt_id || firstCycle?.receipt_id || null;
        const modeUsed = cycle.mode ? cycle.mode : mode;
        setTriggerStatus('Cycles ready: ' + cycleCount + ' • mode ' + modeUsed + ' • first ' + proposalId + (receiptId ? ' • receipt ' + receiptId : ''));
        await load();
      } catch (error) {
        setTriggerStatus('Trigger failed: ' + error.message);
      } finally {
        triggerCycleButton.disabled = false;
      }
    }

    async function load() {
      const search = new URLSearchParams(window.location.search);
      if (!search.get('limit')) search.set('limit', '25');
      if (!search.get('lanes')) search.set('lanes', 'workshop,architects_dream,cto,toxins,graph_board,marketplace');
      const triggerMode = selectedMode();
      search.set('trigger_mode', triggerMode);
      search.set('wave_phase', selectedWavePhase());
      const selectedFeeds = selectedFeedKinds();
      search.set('feed_left', selectedFeeds.left);
      search.set('feed_right', selectedFeeds.right);
      search.set('cadence_s', String(Math.max(5, Math.floor(cadenceIntervalMs() / 1000))));
      const workspaceOnly = workspaceOnlyToggle
        ? workspaceOnlyToggle.checked
        : isWorkspaceOnlyEnabled(search);
      search.set('workspace_only', workspaceOnly ? '1' : '0');
      syncLocationSearch(search);
      const url = '/demo/live-board/snapshot?' + search.toString();
      const started = Date.now();
      try {
        setPollStatus('ok', 'Refreshing');
        const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('snapshot request failed (' + response.status + ')');
        const payload = await response.json();
        const snapshot = payload?.snapshot ?? {};
        latestSnapshot = snapshot;
        const tradeCycles = Array.isArray(snapshot.trade_cycles) ? snapshot.trade_cycles : [];
        latestTradeCycles = tradeCycles;
        tradedAssetIds = buildTradedAssetIds(tradeCycles);
        const snapshotPosts = Array.isArray(snapshot.posts) ? snapshot.posts : [];
        const currentPostIds = new Set(
          snapshotPosts
            .map(row => {
              const intentId = typeof row?.intent_id === 'string' ? row.intent_id.trim() : '';
              if (intentId) return intentId;
              const assetId = typeof row?.asset_id === 'string' ? row.asset_id.trim() : '';
              return assetId;
            })
            .filter(Boolean)
        );
        const currentCycleIds = new Set(
          tradeCycles
            .map(row => (typeof row?.cycle_id === 'string' ? row.cycle_id.trim() : ''))
            .filter(Boolean)
        );
        const nextNewPostIds = new Set();
        const nextNewCycleIds = new Set();
        if (hasInitialSnapshot) {
          for (const id of currentPostIds) {
            if (!seenPostIds.has(id)) nextNewPostIds.add(id);
          }
          for (const id of currentCycleIds) {
            if (!seenCycleIds.has(id)) nextNewCycleIds.add(id);
          }
        }
        newPostIds = nextNewPostIds;
        newCycleIds = nextNewCycleIds;
        seenPostIds = currentPostIds;
        seenCycleIds = currentCycleIds;
        hasInitialSnapshot = true;

        renderLiveFeeds(snapshot);

        const latencyMs = Date.now() - started;
        const visibility = snapshot.workspace_only ? 'workspace-only' : 'all actors';
        const burstParts = [];
        if (newPostIds.size > 0) burstParts.push('+' + newPostIds.size + ' new post' + (newPostIds.size === 1 ? '' : 's'));
        if (newCycleIds.size > 0) burstParts.push('+' + newCycleIds.size + ' new cycle' + (newCycleIds.size === 1 ? '' : 's'));
        const burst = burstParts.length > 0 ? (' • ' + burstParts.join(' • ')) : '';
        meta.textContent = 'Updated ' + shortAgo(snapshot.generated_at) + ' • latency ' + latencyMs + 'ms • ' + visibility + burst;
        setPollStatus('ok', burstParts.length > 0 ? ('Live • ' + burstParts.join(' • ')) : 'Live');
      } catch (error) {
        meta.textContent = 'Snapshot error: ' + error.message;
        setPollStatus('bad', 'Disconnected');
      }
    }

    if (workspaceOnlyToggle) {
      const initialSearch = new URLSearchParams(window.location.search);
      workspaceOnlyToggle.checked = isWorkspaceOnlyEnabled(initialSearch);
      workspaceOnlyToggle.addEventListener('change', () => {
        void load();
      });
    }
    if (triggerModeSelect) {
      const initialSearch = new URLSearchParams(window.location.search);
      const mode = initialSearch.get('trigger_mode');
      triggerModeSelect.value = mode === 'multihop' ? 'multihop' : 'balanced';
      triggerModeSelect.addEventListener('change', () => {
        void load();
      });
    }
    if (wavePhaseSelect) {
      const initialSearch = new URLSearchParams(window.location.search);
      const phase = String(initialSearch.get('wave_phase') || '').toLowerCase();
      wavePhaseSelect.value = phase === 'post' || phase === 'settle' ? phase : 'match';
      wavePhaseSelect.addEventListener('change', () => {
        void load();
      });
    }
    if (feedLeftKindSelect) {
      const initialSearch = new URLSearchParams(window.location.search);
      feedLeftKindSelect.value = normalizeFeedKind(initialSearch.get('feed_left'), 'posts');
      feedLeftKindSelect.addEventListener('change', () => {
        renderLiveFeeds(latestSnapshot ?? {});
        void load();
      });
    }
    if (feedRightKindSelect) {
      const initialSearch = new URLSearchParams(window.location.search);
      feedRightKindSelect.value = normalizeFeedKind(initialSearch.get('feed_right'), 'matches');
      feedRightKindSelect.addEventListener('change', () => {
        renderLiveFeeds(latestSnapshot ?? {});
        void load();
      });
    }
    if (cadenceSecondsInput) {
      const initialSearch = new URLSearchParams(window.location.search);
      const cadenceRaw = Number.parseInt(String(initialSearch.get('cadence_s') ?? ''), 10);
      if (Number.isFinite(cadenceRaw)) cadenceSecondsInput.value = String(Math.max(5, Math.min(3600, cadenceRaw)));
      cadenceSecondsInput.addEventListener('change', () => {
        const seconds = Math.max(5, Math.floor(cadenceIntervalMs() / 1000));
        setCadenceStatus(cadenceRunning()
          ? ('Cadence interval updated • every ' + seconds + 's')
          : ('Cadence paused • interval ' + seconds + 's ready'));
        if (cadenceRunning()) startCadence();
        void load();
      });
    }
    if (postsGrid) {
      postsGrid.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('[data-expand-image=\"1\"]') : null;
        if (!target) return;
        const imageUrl = target.getAttribute('data-image-url');
        const title = target.getAttribute('data-image-title');
        openLightbox({ imageUrl, title });
      });
    }
    if (tradeCyclesGrid) {
      tradeCyclesGrid.addEventListener('click', event => {
        const card = event.target instanceof Element ? event.target.closest('.trade-card[data-cycle-id]') : null;
        if (!card) return;
        const cycleId = card.getAttribute('data-cycle-id');
        if (!cycleId) return;
        selectedCycleId = cycleId;
        renderTradeCycles(latestTradeCycles);
        renderCycleGraph(latestTradeCycles);
      });
      tradeCyclesGrid.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target instanceof Element ? event.target.closest('.trade-card[data-cycle-id]') : null;
        if (!card) return;
        const cycleId = card.getAttribute('data-cycle-id');
        if (!cycleId) return;
        event.preventDefault();
        selectedCycleId = cycleId;
        renderTradeCycles(latestTradeCycles);
        renderCycleGraph(latestTradeCycles);
      });
    }
    function bindFeedInspectorInteractions(container) {
      if (!container) return;
      container.addEventListener('click', event => {
        const imageTrigger = event.target instanceof Element ? event.target.closest('[data-expand-image=\"1\"]') : null;
        if (imageTrigger) {
          const imageUrl = imageTrigger.getAttribute('data-image-url');
          const title = imageTrigger.getAttribute('data-image-title');
          openLightbox({ imageUrl, title });
          return;
        }
        const item = event.target instanceof Element ? event.target.closest('.live-item[data-entry-key]') : null;
        if (!item) return;
        openInspectorByEntryKey(item.getAttribute('data-entry-key'));
      });
      container.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const item = event.target instanceof Element ? event.target.closest('.live-item[data-entry-key]') : null;
        if (!item) return;
        event.preventDefault();
        openInspectorByEntryKey(item.getAttribute('data-entry-key'));
      });
    }
    bindFeedInspectorInteractions(feedLeftList);
    bindFeedInspectorInteractions(feedRightList);
    if (inspectorBody) {
      inspectorBody.addEventListener('click', event => {
        const imageTrigger = event.target instanceof Element ? event.target.closest('[data-expand-image=\"1\"]') : null;
        if (!imageTrigger) return;
        const imageUrl = imageTrigger.getAttribute('data-image-url');
        const title = imageTrigger.getAttribute('data-image-title');
        openLightbox({ imageUrl, title });
      });
    }
    if (inspectorClose) {
      inspectorClose.addEventListener('click', () => {
        selectedFeedEntryKey = null;
        renderInspectorEmpty();
        syncFeedSelectionHighlight();
      });
    }
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    if (lightbox) {
      lightbox.addEventListener('click', event => {
        if (event.target === lightbox) closeLightbox();
      });
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeLightbox();
    });
    if (triggerCycleButton) triggerCycleButton.addEventListener('click', triggerCycle);
    if (triggerWaveButton) triggerWaveButton.addEventListener('click', () => {
      void triggerWave({ source: 'manual' });
    });
    if (cadenceToggleButton) cadenceToggleButton.addEventListener('click', () => {
      if (cadenceRunning()) stopCadence();
      else startCadence();
    });
    window.addEventListener('beforeunload', () => {
      stopCadence();
    });
    refreshCadenceButton();
    load();
    setInterval(load, 3000);
  </script>
</body>
</html>`;
}
