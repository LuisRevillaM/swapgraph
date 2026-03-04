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

  const recentEvents = sortByIsoDescending(
    events.map(event => {
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
    }),
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
      return {
        intent_id: intent?.id ?? null,
        actor_id: actor?.id ?? null,
        actor_type: actor?.type ?? null,
        status: firstNonEmptyString(intent?.status) ?? 'unknown',
        posted_at: asIso(proof?.verified_at) ?? asIso(intent?.updated_at) ?? null,
        asset_id: firstNonEmptyString(offer?.asset_id),
        title: firstNonEmptyString(
          metadata?.title,
          metadata?.name,
          actor?.id ? `Demo output for ${actor.id}` : null
        ),
        prompt_spec: firstNonEmptyString(
          metadata?.prompt_spec,
          metadata?.description,
          metadata?.brief
        ),
        agent_message: firstNonEmptyString(
          metadata?.intent_message,
          metadata?.agent_note,
          metadata?.note
        ),
        style_tags: normalizeStringList(metadata?.style_tags, 8),
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
        updated_at: asIso(receipt?.created_at) ?? asIso(timeline?.updated_at) ?? asIso(proposal?.expires_at),
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
  <style>
    :root {
      --bg: #efece6;
      --surface: #fffdf9;
      --surface-strong: #ffffff;
      --ink: #111418;
      --muted: #5d646e;
      --line: #d6d9df;
      --accent: #0f8f8f;
      --accent-strong: #0b6a8f;
      --warm: #df6e2d;
      --ok: #127f48;
      --warn: #b7791f;
      --bad: #c53030;
      --radius: 14px;
      --mono: "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      --sans: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: var(--sans);
      background:
        radial-gradient(circle at 15% 10%, rgba(15, 143, 143, 0.12), transparent 38%),
        radial-gradient(circle at 85% 0%, rgba(223, 110, 45, 0.16), transparent 40%),
        linear-gradient(180deg, #f9f7f3 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .shell {
      width: min(1400px, 96vw);
      margin: 24px auto 42px;
      display: grid;
      gap: 14px;
    }
    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      background: linear-gradient(125deg, #ffffff, #f8fdfd);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 16px 18px;
      box-shadow: 0 8px 22px rgba(22, 28, 45, 0.08);
    }
    .title {
      margin: 0;
      font-size: clamp(1.05rem, 2vw, 1.35rem);
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.84rem;
      font-family: var(--mono);
    }
    .status-pill {
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 8px 12px;
      font-size: 0.8rem;
      font-family: var(--mono);
      background: var(--surface);
      color: var(--muted);
      min-width: 150px;
      text-align: center;
    }
    .status-pill.ok { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 40%, var(--line)); }
    .status-pill.bad { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 45%, var(--line)); }
    .cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .card {
      background: var(--surface-strong);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px 14px;
      min-height: 88px;
      box-shadow: 0 5px 14px rgba(0, 0, 0, 0.05);
    }
    .card h3 {
      margin: 0;
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 700;
    }
    .card .value {
      margin-top: 9px;
      font-size: clamp(1.1rem, 2vw, 1.65rem);
      font-weight: 700;
      font-family: var(--mono);
      color: var(--accent-strong);
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      overflow: hidden;
    }
    .panel h2 {
      margin: 0 0 8px;
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #374151;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .controls-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .trigger-btn {
      border: 1px solid color-mix(in oklab, var(--accent) 45%, var(--line));
      background: linear-gradient(135deg, #ecfdfd, #fff8f2);
      color: var(--accent-strong);
      border-radius: 999px;
      padding: 8px 13px;
      font-size: 0.77rem;
      font-family: var(--mono);
      font-weight: 700;
      letter-spacing: 0.03em;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease;
    }
    .trigger-btn:hover { transform: translateY(-1px); }
    .trigger-btn:disabled {
      cursor: default;
      opacity: 0.65;
      transform: none;
    }
    .trigger-status {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 0.8rem;
      font-family: var(--mono);
    }
    .toggle-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid #dbe1ea;
      border-radius: 999px;
      padding: 6px 10px;
      background: #ffffff;
      font-size: 0.75rem;
      color: #334155;
      font-family: var(--mono);
      user-select: none;
    }
    .toggle-pill input {
      margin: 0;
      width: 14px;
      height: 14px;
    }
    .essentials {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: 12px;
      align-items: start;
    }
    .stack {
      display: grid;
      gap: 12px;
    }
    .cycle-graph-shell {
      border: 1px solid #e8ecf2;
      border-radius: 12px;
      background: linear-gradient(135deg, #f7fcff, #fffdfb);
      min-height: 250px;
      padding: 10px;
    }
    .cycle-graph {
      width: 100%;
      height: 240px;
      display: block;
    }
    .cycle-node {
      fill: #ffffff;
      stroke: #0f8f8f;
      stroke-width: 2;
    }
    .cycle-edge {
      fill: none;
      stroke: #0f8f8f;
      stroke-width: 2.6;
      stroke-linecap: round;
      stroke-dasharray: 8 10;
      animation: flow 2.2s linear infinite;
    }
    .cycle-arrow {
      fill: #0f8f8f;
    }
    .cycle-label {
      font-size: 11px;
      fill: #0f172a;
      text-anchor: middle;
      font-family: var(--mono);
      font-weight: 600;
    }
    .cycle-sub {
      font-size: 11px;
      color: #64748b;
      font-family: var(--mono);
      margin-top: 6px;
    }
    @keyframes flow {
      from { stroke-dashoffset: 0; }
      to { stroke-dashoffset: -36; }
    }
    .post-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .post-card {
      border: 1px solid #e8ebf2;
      border-radius: 12px;
      background: #ffffff;
      overflow: hidden;
      display: grid;
      grid-template-rows: 160px auto;
      min-height: 264px;
    }
    .post-media-btn {
      border: none;
      padding: 0;
      margin: 0;
      background: transparent;
      width: 100%;
      height: 100%;
      cursor: zoom-in;
    }
    .post-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #f5f7fb;
    }
    .post-copy {
      padding: 9px 10px 11px;
      display: grid;
      gap: 5px;
    }
    .post-copy .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 0.74rem;
      color: #1f2937;
      font-weight: 700;
    }
    .post-copy .title {
      margin: 0;
      font-size: 0.82rem;
      line-height: 1.25;
      color: #111827;
      text-transform: none;
      letter-spacing: normal;
      font-weight: 700;
    }
    .post-copy .prompt {
      margin: 0;
      font-size: 0.74rem;
      line-height: 1.35;
      color: #4b5563;
      font-family: var(--mono);
      min-height: 42px;
    }
    .post-copy .agent-note {
      margin: 0;
      font-size: 0.72rem;
      line-height: 1.35;
      color: #0f766e;
      font-family: var(--sans);
      font-weight: 600;
    }
    .post-copy .meta-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      font-size: 0.72rem;
      color: #6b7280;
      font-family: var(--mono);
    }
    .token-row {
      font-size: 0.68rem;
      color: #475569;
      font-family: var(--mono);
      border-top: 1px dashed #e5e7eb;
      padding-top: 6px;
      margin-top: 2px;
      word-break: break-word;
    }
    .trade-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .trade-card {
      border: 1px solid #e7ebf1;
      border-radius: 12px;
      background: #ffffff;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .trade-card.clickable {
      cursor: pointer;
      transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
    }
    .trade-card.clickable:hover {
      transform: translateY(-1px);
      border-color: #a7d6d6;
      box-shadow: 0 8px 20px rgba(15, 143, 143, 0.14);
    }
    .trade-card.active {
      border-color: #0f8f8f;
      box-shadow: 0 0 0 2px rgba(15, 143, 143, 0.2);
    }
    .trade-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .trade-meta {
      font-size: 0.72rem;
      color: #6b7280;
      font-family: var(--mono);
    }
    .trade-rows {
      display: grid;
      gap: 7px;
    }
    .trade-row {
      display: grid;
      grid-template-columns: minmax(0, 92px) minmax(0, 1fr) 24px minmax(0, 1fr);
      gap: 7px;
      align-items: stretch;
    }
    .trade-actor {
      border: 1px solid #e5eaf1;
      border-radius: 10px;
      padding: 8px 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-size: 0.7rem;
      font-weight: 700;
      color: #334155;
      background: #f9fbfe;
      font-family: var(--mono);
      word-break: break-word;
    }
    .trade-item {
      border: 1px solid #e8ecf4;
      border-radius: 10px;
      overflow: hidden;
      display: grid;
      grid-template-rows: 76px auto;
      background: #fff;
    }
    .trade-item img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #f5f7fb;
    }
    .trade-item-copy {
      padding: 6px;
      display: grid;
      gap: 4px;
      font-size: 0.68rem;
      color: #4b5563;
      font-family: var(--mono);
    }
    .trade-item-copy strong {
      font-size: 0.72rem;
      color: #1f2937;
      line-height: 1.25;
      font-family: var(--sans);
      font-weight: 700;
    }
    .trade-arrow {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      color: #64748b;
      font-weight: 700;
      font-family: var(--mono);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.83rem;
    }
    th, td {
      border-top: 1px solid #eceff3;
      padding: 7px 6px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: #4b5563;
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
      border-top: none;
    }
    td code {
      font-family: var(--mono);
      font-size: 0.75rem;
      color: #334155;
      word-break: break-all;
    }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.68rem;
      font-family: var(--mono);
      border: 1px solid var(--line);
      color: #334155;
      background: #f7fafc;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge.active { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 35%, var(--line)); }
    .badge.idle { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 35%, var(--line)); }
    .badge.stale, .badge.unseen { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 35%, var(--line)); }
    .feed {
      display: grid;
      gap: 7px;
      max-height: 360px;
      overflow: auto;
      padding-right: 4px;
    }
    .feed-item {
      border: 1px solid #ebeff3;
      border-radius: 10px;
      padding: 8px 9px;
      background: #ffffff;
      display: grid;
      gap: 3px;
    }
    .feed-item .row-a {
      font-size: 0.76rem;
      color: #374151;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .feed-item .row-b {
      font-size: 0.72rem;
      color: #6b7280;
      font-family: var(--mono);
      word-break: break-word;
    }
    .empty {
      color: #6b7280;
      font-size: 0.84rem;
      padding: 8px 4px;
    }
    .lightbox {
      position: fixed;
      inset: 0;
      background: rgba(9, 12, 17, 0.72);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 60;
    }
    .lightbox.open {
      display: flex;
    }
    .lightbox-card {
      width: min(980px, 94vw);
      max-height: 92vh;
      background: #0b1118;
      border: 1px solid #1f2937;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .lightbox-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      color: #dbe4ee;
      font-size: 0.76rem;
      font-family: var(--mono);
      background: #111827;
      border-bottom: 1px solid #1f2937;
    }
    .lightbox-head button {
      border: 1px solid #334155;
      background: #0f172a;
      color: #e5e7eb;
      border-radius: 8px;
      cursor: pointer;
      padding: 4px 8px;
      font-family: var(--mono);
      font-size: 0.72rem;
    }
    .lightbox-body {
      display: grid;
      place-items: center;
      padding: 8px;
      background: #050a12;
    }
    .lightbox-body img {
      max-width: 100%;
      max-height: 80vh;
      object-fit: contain;
      border-radius: 8px;
    }
    @media (max-width: 980px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .essentials { grid-template-columns: 1fr; }
      .post-grid { grid-template-columns: 1fr; }
      .trade-grid { grid-template-columns: 1fr; }
      .trade-row { grid-template-columns: 1fr; }
      .trade-arrow { transform: rotate(90deg); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="header">
      <div>
        <h1 class="title">SwapGraph Live Board</h1>
        <div class="meta" id="meta">Waiting for first snapshot…</div>
      </div>
      <div class="status-pill" id="poll-status">Connecting</div>
    </section>

    <section class="cards" id="cards"></section>

    <section class="panel">
      <div class="panel-head">
        <h2>Demo Controls</h2>
        <div class="controls-right">
          <label class="toggle-pill"><input id="workspace-only-toggle" type="checkbox" checked>Only workspace actors</label>
          <label class="toggle-pill">Mode
            <select id="trigger-mode" style="border:none;background:transparent;font-family:var(--mono);font-size:0.75rem;">
              <option value="balanced">Balanced</option>
              <option value="multihop">Multi-hop</option>
            </select>
          </label>
          <button id="trigger-cycle" class="trigger-btn" type="button">Start New Agent Cycle</button>
        </div>
      </div>
      <p class="trigger-status" id="trigger-status">Balanced mode explores emergent pairings. Multi-hop mode biases ring-style 4-actor exchanges.</p>
    </section>

    <section class="essentials">
      <section class="panel stack">
        <div>
          <h2>Animated Cycle Graph</h2>
          <div class="cycle-graph-shell">
            <svg id="cycle-graph" class="cycle-graph" viewBox="0 0 520 240" role="img" aria-label="Latest trade cycle graph"></svg>
            <div class="cycle-sub" id="cycle-graph-meta">Waiting for cycle data…</div>
          </div>
        </div>
        <div>
          <h2>Trade Cycles</h2>
          <div class="trade-grid" id="trade-cycles-grid"></div>
        </div>
      </section>
      <section class="panel stack">
        <div>
          <h2>Creative Posts</h2>
          <div class="post-grid" id="posts-grid"></div>
        </div>
        <div>
          <h2>Recent Activity</h2>
          <div class="feed" id="feed"></div>
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
    const CARD_ORDER = [
      ['Active Intents', 'intents_active'],
      ['Live Cycles', 'timelines_executing'],
      ['Completed Cycles', 'timelines_completed'],
      ['Completed Receipts', 'receipts_completed']
    ];

    const byId = id => document.getElementById(id);
    const cards = byId('cards');
    const cycleGraph = byId('cycle-graph');
    const cycleGraphMeta = byId('cycle-graph-meta');
    const postsGrid = byId('posts-grid');
    const tradeCyclesGrid = byId('trade-cycles-grid');
    const feed = byId('feed');
    const meta = byId('meta');
    const pollStatus = byId('poll-status');
    const triggerCycleButton = byId('trigger-cycle');
    const triggerModeSelect = byId('trigger-mode');
    const workspaceOnlyToggle = byId('workspace-only-toggle');
    const triggerStatus = byId('trigger-status');
    const lightbox = byId('lightbox');
    const lightboxImage = byId('lightbox-image');
    const lightboxTitle = byId('lightbox-title');
    const lightboxClose = byId('lightbox-close');
    let selectedCycleId = null;
    let latestTradeCycles = [];

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

    function renderCards(funnel) {
      cards.innerHTML = CARD_ORDER.map(([label, key]) => {
        const value = Number.isFinite(funnel?.[key]) ? funnel[key] : 0;
        return '<article class="card"><h3>' + esc(label) + '</h3><div class="value">' + esc(value) + '</div></article>';
      }).join('');
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
        const tokenBits = [];
        if (capability?.token_id) tokenBits.push(capability.token_id);
        if (capability?.delivery_target) tokenBits.push(capability.delivery_target);
        if (capability?.expires_at) tokenBits.push('exp ' + shortAgo(capability.expires_at));
        const tokenRow = tokenBits.length > 0 ? ('<div class="token-row">capability: ' + esc(tokenBits.join(' • ')) + '</div>') : '';
        return '<article class="post-card">'
          + image
          + '<div class="post-copy">'
          + '<div class="top"><span class="badge">' + esc(actor) + '</span><span>' + esc(posted) + '</span></div>'
          + '<p class="title">' + esc(row.title ?? row.intent_id ?? 'Untitled') + '</p>'
          + '<p class="prompt">' + esc(row.prompt_spec ?? 'No prompt provided') + '</p>'
          + (agentNote ? ('<p class="agent-note">"' + esc(agentNote) + '"</p>') : '')
          + '<div class="meta-row"><span>' + esc(row.deliverable_type ?? 'deliverable') + '</span><span>' + esc(value) + '</span></div>'
          + '<div class="meta-row"><span>' + esc(novelty) + '</span><span>' + esc(tags ?? '') + '</span></div>'
          + tokenRow
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
        const receipt = cycle.receipt_id ? ('receipt ' + cycle.receipt_id) : 'no receipt yet';
        const updated = cycle.updated_at ? shortAgo(cycle.updated_at) : 'n/a';
        const cycleId = cycle.cycle_id || '';
        const isActive = cycleId && cycleId === selectedCycleId;
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
            + '<div class="trade-arrow">→</div>'
            + '<div class="trade-item">'
            + (gets.image_url ? '<img src="' + esc(gets.image_url) + '" alt="' + esc(gets.title || gets.asset_id || 'get asset') + '" loading="lazy">' : '<img alt="no get image" loading="lazy">')
            + '<div class="trade-item-copy"><span>Gets</span><strong>' + esc(gets.title || gets.asset_id || 'asset') + '</strong><span>' + esc((gets.deliverable_type || 'asset') + ' • ' + getValue) + '</span></div>'
            + '</div>'
            + '</div>';
        }).join('');
        return '<article class="trade-card clickable' + (isActive ? ' active' : '') + '" data-cycle-id="' + esc(cycleId) + '" role="button" tabindex="0" aria-label="Focus cycle ' + esc(cycleId || 'cycle') + '">'
          + '<div class="trade-head"><code>' + esc(cycle.cycle_id || 'cycle') + '</code><span class="badge">' + esc(state) + '</span></div>'
          + '<div class="trade-meta">' + esc(receipt + ' • updated ' + updated) + '</div>'
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
      for (const participant of participants) {
        const from = String(participant?.actor_id ?? '').trim();
        if (!from) continue;
        const givesAssetId = participant?.gives?.asset_id ? String(participant.gives.asset_id) : null;
        let to = null;
        if (givesAssetId) {
          for (const candidate of participants) {
            const candidateGetsAssetId = candidate?.gets?.asset_id ? String(candidate.gets.asset_id) : null;
            if (candidateGetsAssetId && candidateGetsAssetId === givesAssetId) {
              to = String(candidate?.actor_id ?? '').trim();
              break;
            }
          }
        }
        if (!to) {
          const fromIdx = actorIds.indexOf(from);
          to = fromIdx >= 0 ? actorIds[(fromIdx + 1) % actorIds.length] : null;
        }
        if (!to || from === to) continue;
        edges.push({ from, to });
      }

      const markerDefs = '<defs><marker id="cycle-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon class="cycle-arrow" points="0 0, 10 3.5, 0 7"></polygon></marker></defs>';
      const edgeSvg = edges.map((edge, idx) => {
        const fromPoint = pointByActorId.get(edge.from);
        const toPoint = pointByActorId.get(edge.to);
        if (!fromPoint || !toPoint) return '';
        return '<path class="cycle-edge" d="M ' + fromPoint.x.toFixed(2) + ' ' + fromPoint.y.toFixed(2)
          + ' L ' + toPoint.x.toFixed(2) + ' ' + toPoint.y.toFixed(2)
          + '" marker-end="url(#cycle-arrowhead)" style="animation-delay:' + (idx * 0.18).toFixed(2) + 's"></path>';
      }).join('');
      const nodeSvg = points.map(point => {
        return '<g>'
          + '<circle class="cycle-node" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="22"></circle>'
          + '<text class="cycle-label" x="' + point.x.toFixed(2) + '" y="' + (point.y + 4).toFixed(2) + '">' + esc(point.actor_id) + '</text>'
          + '</g>';
      }).join('');
      cycleGraph.innerHTML = markerDefs + edgeSvg + nodeSvg;
      const state = cycle?.state ? cycle.state : 'proposed';
      cycleGraphMeta.textContent = 'Cycle ' + (cycle?.cycle_id ?? 'n/a') + ' • ' + state + ' • ' + actorIds.length + '-actor flow';
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
        return '<article class="feed-item">'
          + '<div class="row-a"><strong>' + esc(row.type) + '</strong><span>' + esc(shortAgo(row.occurred_at)) + '</span></div>'
          + '<div class="row-b">' + esc(actor) + (cycle || intent ? ' • ' + esc(cycle + intent) : '') + '</div>'
          + '<div class="row-b">' + esc(row.summary ?? '') + '</div>'
          + '</article>';
      }).join('');
    }

    function setPollStatus(kind, text) {
      pollStatus.className = 'status-pill ' + kind;
      pollStatus.textContent = text;
    }

    function setTriggerStatus(text) {
      triggerStatus.textContent = text;
    }

    async function triggerCycle() {
      if (!triggerCycleButton) return;
      triggerCycleButton.disabled = true;
      const mode = triggerModeSelect?.value === 'multihop' ? 'multihop' : 'balanced';
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
      const triggerMode = triggerModeSelect?.value === 'multihop' ? 'multihop' : 'balanced';
      search.set('trigger_mode', triggerMode);
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
        const tradeCycles = Array.isArray(snapshot.trade_cycles) ? snapshot.trade_cycles : [];
        latestTradeCycles = tradeCycles;
        if (selectedCycleId && !tradeCycles.some(row => row?.cycle_id === selectedCycleId)) {
          selectedCycleId = null;
        }
        if (!selectedCycleId && tradeCycles.length > 0) {
          selectedCycleId = tradeCycles[0]?.cycle_id ?? null;
        }

        renderCards(snapshot.funnel ?? {});
        renderPosts(snapshot.posts ?? []);
        renderTradeCycles(tradeCycles);
        renderCycleGraph(tradeCycles);
        renderFeed(snapshot.events ?? []);

        const latencyMs = Date.now() - started;
        const visibility = snapshot.workspace_only ? 'workspace-only' : 'all actors';
        meta.textContent = 'Updated ' + shortAgo(snapshot.generated_at) + ' • latency ' + latencyMs + 'ms • ' + visibility;
        setPollStatus('ok', 'Live');
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
    load();
    setInterval(load, 4000);
  </script>
</body>
</html>`;
}
