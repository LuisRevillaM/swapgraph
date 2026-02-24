const els = {
  runtimeUrl: document.getElementById('runtime-url'),
  healthBackend: document.getElementById('health-backend'),
  healthMode: document.getElementById('health-mode'),
  healthIntents: document.getElementById('health-intents'),

  userAId: document.getElementById('user-a-id'),
  userBId: document.getElementById('user-b-id'),
  partnerId: document.getElementById('partner-id'),
  maxProposals: document.getElementById('max-proposals'),

  assetA: document.getElementById('asset-a'),
  assetB: document.getElementById('asset-b'),
  valueA: document.getElementById('value-a'),
  valueB: document.getElementById('value-b'),
  seedIds: document.getElementById('seed-ids'),

  runId: document.getElementById('run-id'),
  runSelected: document.getElementById('run-selected'),
  runCycles: document.getElementById('run-cycles'),
  runProposals: document.getElementById('run-proposals'),

  proposalSelect: document.getElementById('proposal-select'),
  proposalTable: document.getElementById('proposal-table'),
  responseViewer: document.getElementById('response-viewer'),
  eventLog: document.getElementById('event-log'),

  btnHealth: document.getElementById('btn-health'),
  btnReset: document.getElementById('btn-reset'),
  btnSeedPair: document.getElementById('btn-seed-pair'),
  btnListIntents: document.getElementById('btn-list-intents'),
  btnRunMatching: document.getElementById('btn-run-matching'),
  btnLoadProposals: document.getElementById('btn-load-proposals'),
  btnInspectProposal: document.getElementById('btn-inspect-proposal')
};

const state = {
  proxyUpstream: null,
  seedIntentIds: { a: null, b: null },
  lastRun: null,
  lastProposals: []
};

function token(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function setDefaults() {
  els.userAId.value = `user_a_${Date.now().toString(36).slice(-5)}`;
  els.userBId.value = `user_b_${Date.now().toString(36).slice(-5)}`;
  els.partnerId.value = 'marketplace';
  els.maxProposals.value = '20';
  els.assetA.value = `asset_a_${Date.now().toString(36).slice(-4)}`;
  els.assetB.value = `asset_b_${Date.now().toString(36).slice(-4)}`;
  els.valueA.value = '100';
  els.valueB.value = '101';
  els.seedIds.textContent = '';
  renderProposalSelect([]);
}

function logEvent(level, message) {
  const row = document.createElement('div');
  row.className = 'log-entry';
  const levelClass = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'err';
  row.innerHTML = `
    <div class="log-time">${new Date().toISOString().slice(11, 19)}</div>
    <div><span class="tag ${levelClass}">${level.toUpperCase()}</span>${escapeHtml(message)}</div>
  `;
  els.eventLog.prepend(row);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function showResponse(data) {
  els.responseViewer.textContent = JSON.stringify(data, null, 2);
}

async function apiRequest({
  method = 'GET',
  path,
  actorType = null,
  actorId = null,
  scopes = [],
  idempotencyKey = null,
  body = undefined
}) {
  const headers = {
    accept: 'application/json'
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (actorType) headers['x-actor-type'] = actorType;
  if (actorId) headers['x-actor-id'] = actorId;
  if (scopes.length > 0) headers['x-auth-scopes'] = scopes.join(' ');
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const upstream = response.headers.get('x-proxy-upstream');
  if (upstream) {
    state.proxyUpstream = upstream;
    els.runtimeUrl.textContent = upstream;
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${method} ${path}`);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }

  return {
    status: response.status,
    body: parsed
  };
}

function buildIntentPayload({ intentId, actorId, offerAssetId, wantAssetId, valueUsd }) {
  return {
    intent: {
      id: intentId,
      actor: {
        type: 'user',
        id: actorId
      },
      offer: [
        {
          platform: 'steam',
          app_id: 730,
          context_id: 2,
          asset_id: offerAssetId,
          class_id: `cls_${offerAssetId}`,
          instance_id: '0',
          metadata: {
            value_usd: valueUsd
          },
          proof: {
            inventory_snapshot_id: `snap_${offerAssetId}`,
            verified_at: new Date().toISOString()
          }
        }
      ],
      want_spec: {
        type: 'set',
        any_of: [
          {
            type: 'specific_asset',
            platform: 'steam',
            asset_key: `steam:${wantAssetId}`
          }
        ]
      },
      value_band: {
        min_usd: Math.max(1, valueUsd - 20),
        max_usd: valueUsd + 20,
        pricing_source: 'market_median'
      },
      trust_constraints: {
        max_cycle_length: 3,
        min_counterparty_reliability: 0
      },
      time_constraints: {
        expires_at: '2027-12-31T00:00:00.000Z',
        urgency: 'normal'
      },
      settlement_preferences: {
        require_escrow: true
      }
    }
  };
}

async function checkHealth() {
  const res = await apiRequest({ method: 'GET', path: '/healthz' });
  showResponse(res.body);
  els.healthBackend.textContent = res.body?.store_backend ?? 'n/a';
  els.healthMode.textContent = res.body?.persistence_mode ?? 'n/a';
  els.healthIntents.textContent = String(res.body?.state?.intents ?? 'n/a');
  logEvent('ok', `Health check passed (${res.body?.store_backend ?? 'unknown'})`);
}

async function seedPair() {
  const nonce = Date.now().toString(36);
  const intentAId = token('intent_a');
  const intentBId = token('intent_b');
  const userA = els.userAId.value.trim();
  const userB = els.userBId.value.trim();
  const assetA = `${els.assetA.value.trim() || `asset_a_${nonce}`}_${nonce}`;
  const assetB = `${els.assetB.value.trim() || `asset_b_${nonce}`}_${nonce}`;
  const valueA = Number.parseFloat(els.valueA.value) || 100;
  const valueB = Number.parseFloat(els.valueB.value) || 101;

  const reqA = buildIntentPayload({
    intentId: intentAId,
    actorId: userA,
    offerAssetId: assetA,
    wantAssetId: assetB,
    valueUsd: valueA
  });
  const reqB = buildIntentPayload({
    intentId: intentBId,
    actorId: userB,
    offerAssetId: assetB,
    wantAssetId: assetA,
    valueUsd: valueB
  });

  const created = [];

  const a = await apiRequest({
    method: 'POST',
    path: '/swap-intents',
    actorType: 'user',
    actorId: userA,
    scopes: ['swap_intents:write'],
    idempotencyKey: token('seed_a'),
    body: reqA
  });
  created.push(a.body?.intent?.id ?? intentAId);

  const b = await apiRequest({
    method: 'POST',
    path: '/swap-intents',
    actorType: 'user',
    actorId: userB,
    scopes: ['swap_intents:write'],
    idempotencyKey: token('seed_b'),
    body: reqB
  });
  created.push(b.body?.intent?.id ?? intentBId);

  state.seedIntentIds = {
    a: created[0],
    b: created[1]
  };
  els.seedIds.textContent = `Created: ${created.join(', ')}`;
  showResponse({ created_intents: created });
  logEvent('ok', `Created paired intents ${created[0]} and ${created[1]}`);
}

async function listIntents() {
  const userA = els.userAId.value.trim();
  const userB = els.userBId.value.trim();
  const [a, b] = await Promise.all([
    apiRequest({
      method: 'GET',
      path: '/swap-intents',
      actorType: 'user',
      actorId: userA,
      scopes: ['swap_intents:read']
    }),
    apiRequest({
      method: 'GET',
      path: '/swap-intents',
      actorType: 'user',
      actorId: userB,
      scopes: ['swap_intents:read']
    })
  ]);

  const intentsA = Array.isArray(a.body?.intents) ? a.body.intents : [];
  const intentsB = Array.isArray(b.body?.intents) ? b.body.intents : [];
  showResponse({
    user_a_id: userA,
    user_b_id: userB,
    user_a_intents: intentsA,
    user_b_intents: intentsB
  });
  logEvent('ok', `Listed intents (A=${intentsA.length}, B=${intentsB.length})`);
}

async function runMatching() {
  const partnerId = els.partnerId.value.trim();
  const maxProposals = Number.parseInt(els.maxProposals.value, 10) || 20;

  const res = await apiRequest({
    method: 'POST',
    path: '/marketplace/matching/runs',
    actorType: 'partner',
    actorId: partnerId,
    scopes: ['settlement:write'],
    idempotencyKey: token('run'),
    body: {
      replace_existing: true,
      max_proposals: maxProposals
    }
  });

  const run = res.body?.run ?? null;
  state.lastRun = run;
  els.runId.textContent = run?.run_id ?? 'n/a';
  els.runSelected.textContent = String(run?.selected_proposals_count ?? 'n/a');
  els.runCycles.textContent = String(run?.stats?.candidate_cycles ?? 'n/a');
  els.runProposals.textContent = String(run?.stats?.candidate_proposals ?? 'n/a');
  showResponse(res.body);
  logEvent('ok', `Matching run ${run?.run_id ?? '(unknown)'} selected=${run?.selected_proposals_count ?? 0}`);
}

function renderProposalSelect(proposals) {
  const rows = Array.isArray(proposals) ? proposals : [];
  if (rows.length === 0) {
    els.proposalSelect.innerHTML = '<option value="">No proposals loaded</option>';
    return;
  }
  els.proposalSelect.innerHTML = rows
    .map(row => `<option value="${row.id}">${row.id}</option>`)
    .join('');
}

function renderProposalTable(proposals) {
  const rows = Array.isArray(proposals) ? proposals : [];
  if (rows.length === 0) {
    els.proposalTable.innerHTML = '<p class="small">No proposals loaded.</p>';
    return;
  }

  const html = rows.map(row => {
    const participants = Array.isArray(row.participants) ? row.participants.length : 0;
    const confidence = row.confidence_score ?? null;
    const spread = row.value_spread ?? null;
    return `<tr>
      <td class="mono">${escapeHtml(row.id)}</td>
      <td>${participants}</td>
      <td>${confidence === null ? 'n/a' : Number(confidence).toFixed(4)}</td>
      <td>${spread === null ? 'n/a' : Number(spread).toFixed(4)}</td>
      <td class="mono">${escapeHtml(String(row.expires_at ?? 'n/a'))}</td>
    </tr>`;
  }).join('');

  els.proposalTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Proposal ID</th>
          <th>Participants</th>
          <th>Confidence</th>
          <th>Value Spread</th>
          <th>Expires</th>
        </tr>
      </thead>
      <tbody>${html}</tbody>
    </table>
  `;
}

async function loadProposals() {
  const partnerId = els.partnerId.value.trim();
  const res = await apiRequest({
    method: 'GET',
    path: '/cycle-proposals',
    actorType: 'partner',
    actorId: partnerId,
    scopes: ['cycle_proposals:read']
  });

  const proposals = Array.isArray(res.body?.proposals) ? res.body.proposals : [];
  state.lastProposals = proposals;
  renderProposalSelect(proposals);
  renderProposalTable(proposals);
  showResponse(res.body);
  logEvent('ok', `Loaded ${proposals.length} proposals`);
}

async function inspectProposal() {
  const proposalId = els.proposalSelect.value;
  if (!proposalId) throw new Error('Select a proposal first');
  const partnerId = els.partnerId.value.trim();
  const res = await apiRequest({
    method: 'GET',
    path: `/cycle-proposals/${encodeURIComponent(proposalId)}`,
    actorType: 'partner',
    actorId: partnerId,
    scopes: ['cycle_proposals:read']
  });
  showResponse(res.body);
  logEvent('ok', `Fetched proposal ${proposalId}`);
}

async function runAction(fn) {
  try {
    await fn();
  } catch (error) {
    const payload = {
      error: String(error?.message ?? error),
      status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
      body: error?.body ?? null
    };
    showResponse(payload);
    logEvent('err', payload.error);
  }
}

els.btnHealth.addEventListener('click', () => runAction(checkHealth));
els.btnReset.addEventListener('click', () => runAction(async () => {
  setDefaults();
  logEvent('warn', 'Local client form state reset');
}));
els.btnSeedPair.addEventListener('click', () => runAction(seedPair));
els.btnListIntents.addEventListener('click', () => runAction(listIntents));
els.btnRunMatching.addEventListener('click', () => runAction(runMatching));
els.btnLoadProposals.addEventListener('click', () => runAction(loadProposals));
els.btnInspectProposal.addEventListener('click', () => runAction(inspectProposal));

setDefaults();
logEvent('ok', 'Marketplace client ready');
