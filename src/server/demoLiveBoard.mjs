function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asIso(value) {
  return typeof value === 'string' && parseIsoMs(value) !== null ? value : null;
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

export function buildDemoLiveBoardSnapshot({ store, nowIso = new Date().toISOString(), limit = 25, laneHints = [] }) {
  const state = store?.state ?? {};
  const intents = Object.values(state.intents ?? {});
  const proposals = Object.values(state.proposals ?? {});
  const commits = Object.values(state.commits ?? {});
  const timelines = Object.values(state.timelines ?? {});
  const receipts = Object.values(state.receipts ?? {});
  const events = Array.isArray(state.events) ? state.events : [];
  const matchingRuns = Object.values(state.marketplace_matching_runs ?? {});

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
    : ['workshop', 'architects_dream', 'graph_board', 'marketplace'];

  return {
    generated_at: nowIso,
    limit,
    funnel,
    lanes: buildLaneRows({ actorRows, laneHints: defaultHints, nowIso }),
    actors: actorRows.slice(0, limit),
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
    .grid-3 {
      display: grid;
      grid-template-columns: 1.15fr 1fr 1fr;
      gap: 12px;
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
    @media (max-width: 980px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-3 { grid-template-columns: 1fr; }
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
      <h2>Lane Activity</h2>
      <table>
        <thead>
          <tr>
            <th>Lane</th>
            <th>Status</th>
            <th>Actors</th>
            <th>Intents</th>
            <th>Commits</th>
            <th>Deposits</th>
            <th>Receipts</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody id="lanes-body"></tbody>
      </table>
    </section>

    <section class="grid-3">
      <section class="panel">
        <h2>Cycles</h2>
        <table>
          <thead>
            <tr>
              <th>Cycle</th>
              <th>State</th>
              <th>Legs</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody id="cycles-body"></tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Receipts</h2>
        <table>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>State</th>
              <th>Assets</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="receipts-body"></tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Matching Runs</h2>
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Selected</th>
              <th>Candidates</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody id="runs-body"></tbody>
        </table>
      </section>
    </section>

    <section class="panel">
      <h2>Recent Activity</h2>
      <div class="feed" id="feed"></div>
    </section>
  </main>

  <script>
    const CARD_ORDER = [
      ['Active Intents', 'intents_active'],
      ['Open Proposals', 'proposals_open'],
      ['Committed Cycles', 'proposals_committed'],
      ['Escrow Pending', 'timelines_escrow_pending'],
      ['Escrow Ready', 'timelines_escrow_ready'],
      ['Executing', 'timelines_executing'],
      ['Completed Cycles', 'timelines_completed'],
      ['Completed Receipts', 'receipts_completed']
    ];

    const byId = id => document.getElementById(id);
    const cards = byId('cards');
    const lanesBody = byId('lanes-body');
    const cyclesBody = byId('cycles-body');
    const receiptsBody = byId('receipts-body');
    const runsBody = byId('runs-body');
    const feed = byId('feed');
    const meta = byId('meta');
    const pollStatus = byId('poll-status');

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

    function renderCards(funnel) {
      cards.innerHTML = CARD_ORDER.map(([label, key]) => {
        const value = Number.isFinite(funnel?.[key]) ? funnel[key] : 0;
        return '<article class="card"><h3>' + esc(label) + '</h3><div class="value">' + esc(value) + '</div></article>';
      }).join('');
    }

    function renderLanes(rows) {
      if (!rows || rows.length === 0) {
        lanesBody.innerHTML = '<tr><td colspan="8" class="empty">No lane hints configured.</td></tr>';
        return;
      }
      lanesBody.innerHTML = rows.map(row => {
        const actorPreview = row.actor_ids.slice(0, 2).join(', ');
        const actorLabel = row.actor_count > 0
          ? esc(actorPreview + (row.actor_count > 2 ? ', +' + (row.actor_count - 2) : ''))
          : 'none';
        return '<tr>'
          + '<td><code>' + esc(row.lane) + '</code></td>'
          + '<td><span class="badge ' + esc(row.status) + '">' + esc(row.status) + '</span></td>'
          + '<td>' + actorLabel + '</td>'
          + '<td>' + esc(row.intents_posted) + '</td>'
          + '<td>' + esc(row.commit_accepts) + '</td>'
          + '<td>' + esc(row.deposits_confirmed) + '</td>'
          + '<td>' + esc(row.receipts_created) + '</td>'
          + '<td>' + esc(shortAgo(row.last_seen_at)) + '</td>'
          + '</tr>';
      }).join('');
    }

    function renderCycles(rows) {
      if (!rows || rows.length === 0) {
        cyclesBody.innerHTML = '<tr><td colspan="4" class="empty">No settlement timelines yet.</td></tr>';
        return;
      }
      cyclesBody.innerHTML = rows.map(row => {
        const legs = row.legs_released + '/' + row.legs_total + ' released';
        return '<tr>'
          + '<td><code>' + esc(row.cycle_id ?? 'n/a') + '</code></td>'
          + '<td><span class="badge">' + esc(row.state ?? 'n/a') + '</span></td>'
          + '<td>' + esc(legs) + '</td>'
          + '<td>' + esc(shortAgo(row.updated_at)) + '</td>'
          + '</tr>';
      }).join('');
    }

    function renderReceipts(rows) {
      if (!rows || rows.length === 0) {
        receiptsBody.innerHTML = '<tr><td colspan="4" class="empty">No receipts yet.</td></tr>';
        return;
      }
      receiptsBody.innerHTML = rows.map(row => {
        return '<tr>'
          + '<td><code>' + esc(row.id ?? 'n/a') + '</code></td>'
          + '<td><span class="badge">' + esc(row.final_state ?? 'n/a') + '</span></td>'
          + '<td>' + esc(row.asset_count) + '</td>'
          + '<td>' + esc(shortAgo(row.created_at)) + '</td>'
          + '</tr>';
      }).join('');
    }

    function renderRuns(rows) {
      if (!rows || rows.length === 0) {
        runsBody.innerHTML = '<tr><td colspan="4" class="empty">No matching runs recorded.</td></tr>';
        return;
      }
      runsBody.innerHTML = rows.map(row => {
        return '<tr>'
          + '<td><code>' + esc(row.run_id ?? 'n/a') + '</code></td>'
          + '<td>' + esc(row.selected_proposals_count) + '</td>'
          + '<td>' + esc(row.candidate_cycles) + '</td>'
          + '<td>' + esc(shortAgo(row.recorded_at)) + '</td>'
          + '</tr>';
      }).join('');
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

    async function load() {
      const search = new URLSearchParams(window.location.search);
      if (!search.get('limit')) search.set('limit', '25');
      if (!search.get('lanes')) search.set('lanes', 'workshop,architects_dream,graph_board,marketplace');
      const url = '/demo/live-board/snapshot?' + search.toString();
      const started = Date.now();
      try {
        setPollStatus('ok', 'Refreshing');
        const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('snapshot request failed (' + response.status + ')');
        const payload = await response.json();
        const snapshot = payload?.snapshot ?? {};

        renderCards(snapshot.funnel ?? {});
        renderLanes(snapshot.lanes ?? []);
        renderCycles(snapshot.cycles ?? []);
        renderReceipts(snapshot.receipts ?? []);
        renderRuns(snapshot.matching_runs ?? []);
        renderFeed(snapshot.events ?? []);

        const latencyMs = Date.now() - started;
        meta.textContent = 'Updated ' + shortAgo(snapshot.generated_at) + ' • latency ' + latencyMs + 'ms';
        setPollStatus('ok', 'Live');
      } catch (error) {
        meta.textContent = 'Snapshot error: ' + error.message;
        setPollStatus('bad', 'Disconnected');
      }
    }

    load();
    setInterval(load, 4000);
  </script>
</body>
</html>`;
}
