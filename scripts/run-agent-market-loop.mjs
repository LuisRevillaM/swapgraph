#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function nowIso() {
  return new Date().toISOString();
}

function actor(type, id) {
  return { type, id };
}

function actorHeaders({ actorRef, scopes, idempotencyKey }) {
  return {
    'content-type': 'application/json',
    'x-now-iso': nowIso(),
    'x-actor-type': actorRef.type,
    'x-actor-id': actorRef.id,
    'x-auth-scopes': scopes.join(' '),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
  };
}

async function api({ baseUrl, actorRef, scopes, method, pathName, body, idempotencyKey, allowFailure = false }) {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: actorHeaders({ actorRef, scopes, idempotencyKey }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok && !allowFailure) {
    throw new Error(`${method} ${pathName} failed: ${res.status} ${JSON.stringify(parsed)}`);
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error(`runtime did not become healthy within ${timeoutMs}ms`);
}

function startRuntime({ rootDir, port, stateFile }) {
  const child = spawn('npm', ['run', 'start:api'], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      AUTHZ_ENFORCE: '1',
      STATE_BACKEND: 'json',
      STATE_FILE: stateFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => {
    logs += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    logs += chunk.toString();
  });
  return { child, logsRef: () => logs };
}

function stopRuntime(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

function key(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function runDirectFlow(baseUrl) {
  const workspaceId = `agent_direct_${Date.now()}`;
  const seller = actor('user', `seller_direct_${Date.now()}`);
  const buyer = actor('user', `buyer_direct_${Date.now()}`);
  const scopes = ['market:read', 'market:write', 'receipts:read'];

  const sellerListing = await api({
    baseUrl, actorRef: seller, scopes, method: 'POST', pathName: '/market/listings', idempotencyKey: key('direct-seller'),
    body: {
      recorded_at: nowIso(),
      listing: {
        listing_id: `direct_post_${Date.now()}`,
        workspace_id: workspaceId,
        kind: 'post',
        title: 'Seller offers audit coverage',
        offer: [{ platform: 'market', asset_id: 'audit_coverage', metadata: { category: 'service_audit' }, estimated_value_usd: 15 }]
      }
    }
  });

  const buyerListing = await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: '/market/listings', idempotencyKey: key('direct-buyer'),
    body: {
      recorded_at: nowIso(),
      listing: {
        listing_id: `direct_want_${Date.now()}`,
        workspace_id: workspaceId,
        kind: 'want',
        title: 'Buyer needs audit coverage',
        want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'market', asset_key: 'market:audit_coverage' }] },
        budget: { amount: 15, currency: 'USD' }
      }
    }
  });

  const edge = await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: '/market/edges', idempotencyKey: key('direct-edge'),
    body: {
      recorded_at: nowIso(),
      edge: {
        source_ref: { kind: 'listing', id: buyerListing.body.listing.listing_id },
        target_ref: { kind: 'listing', id: sellerListing.body.listing.listing_id },
        edge_type: 'offer',
        terms_patch: { cash_amount: 15, currency: 'USD' }
      }
    }
  });
  await api({ baseUrl, actorRef: seller, scopes, method: 'POST', pathName: `/market/edges/${edge.body.edge.edge_id}/accept`, idempotencyKey: key('direct-edge-accept'), body: { recorded_at: nowIso() } });
  const deal = await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: `/market/deals/from-edge/${edge.body.edge.edge_id}`, idempotencyKey: key('direct-deal'),
    body: { recorded_at: nowIso() }
  });
  await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: `/market/deals/${deal.body.deal.deal_id}/start-settlement`, idempotencyKey: key('direct-deal-start'),
    body: { settlement_mode: 'internal_credit', terms: { credit_amount: 15, currency: 'USD' }, recorded_at: nowIso() }
  });
  await api({
    baseUrl, actorRef: seller, scopes, method: 'POST', pathName: `/market/deals/${deal.body.deal.deal_id}/complete`, idempotencyKey: key('direct-deal-complete'),
    body: { recorded_at: nowIso() }
  });
  const receipt = await api({ baseUrl, actorRef: buyer, scopes, method: 'GET', pathName: `/market/deals/${deal.body.deal.deal_id}/receipt` });
  return { workspace_id: workspaceId, edge_id: edge.body.edge.edge_id, deal_id: deal.body.deal.deal_id, receipt_id: receipt.body.receipt.id };
}

async function runMixedFlow(baseUrl) {
  const workspaceId = `agent_mixed_${Date.now()}`;
  const seller = actor('user', `seller_mixed_${Date.now()}`);
  const buyer = actor('user', `buyer_mixed_${Date.now()}`);
  const scopes = ['market:read', 'market:write', 'receipts:read'];

  const blueprint = await api({
    baseUrl, actorRef: seller, scopes, method: 'POST', pathName: '/market/blueprints', idempotencyKey: key('mixed-blueprint'),
    body: {
      recorded_at: nowIso(),
      blueprint: {
        blueprint_id: `bp_mixed_${Date.now()}`,
        workspace_id: workspaceId,
        title: 'Agent deploy template',
        category: 'agent_template',
        artifact_ref: 'https://example.com/agent-deploy-template.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 35 }
      }
    }
  });
  await api({ baseUrl, actorRef: seller, scopes, method: 'POST', pathName: `/market/blueprints/${blueprint.body.blueprint.blueprint_id}/publish`, idempotencyKey: key('mixed-publish'), body: { recorded_at: nowIso() } });

  await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: '/market/listings', idempotencyKey: key('mixed-want'),
    body: {
      recorded_at: nowIso(),
      listing: {
        listing_id: `want_mixed_${Date.now()}`,
        workspace_id: workspaceId,
        kind: 'want',
        title: 'Need deploy template',
        want_spec: { type: 'set', any_of: [{ type: 'category', category: 'blueprint:agent_template' }] },
        budget: { amount: 35, currency: 'USD' }
      }
    }
  });

  const computed = await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: '/market/candidates/compute', idempotencyKey: key('mixed-compute'),
    body: { workspace_id: workspaceId, max_cycle_length: 3, max_candidates: 10, recorded_at: nowIso() }
  });
  const candidate = computed.body.candidates.find(row => row.candidate_type === 'mixed');
  if (!candidate) throw new Error('mixed candidate not found');
  const planCreated = await api({
    baseUrl, actorRef: buyer, scopes, method: 'POST',
    pathName: `/market/execution-plans/from-candidate/${candidate.candidate_id}`,
    idempotencyKey: key('mixed-plan'),
    body: { recorded_at: nowIso() }
  });
  const planId = planCreated.body.plan.plan_id;
  await api({ baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('mixed-accept-buyer'), body: { recorded_at: nowIso() } });
  await api({ baseUrl, actorRef: seller, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('mixed-accept-seller'), body: { recorded_at: nowIso() } });
  const started = await api({ baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/start-settlement`, idempotencyKey: key('mixed-start'), body: { settlement_mode: 'external_payment_proof', recorded_at: nowIso() } });

  for (const leg of started.body.plan.transfer_legs) {
    await api({
      baseUrl,
      actorRef: leg.from_actor,
      scopes,
      method: 'POST',
      pathName: `/market/execution-plans/${planId}/complete-leg/${leg.leg_id}`,
      idempotencyKey: key(`mixed-complete-${leg.leg_id}`),
      body: { verification_result: { status: 'ok' }, recorded_at: nowIso() }
    });
  }
  const receipt = await api({ baseUrl, actorRef: buyer, scopes, method: 'GET', pathName: `/market/execution-plans/${planId}/receipt` });
  return { workspace_id: workspaceId, candidate_id: candidate.candidate_id, plan_id: planId, receipt_id: receipt.body.receipt.id };
}

async function runCycleFlow(baseUrl) {
  const workspaceId = `agent_cycle_${Date.now()}`;
  const actorA = actor('user', `cycle_a_${Date.now()}`);
  const actorB = actor('user', `cycle_b_${Date.now()}`);
  const actorC = actor('user', `cycle_c_${Date.now()}`);
  const scopes = ['market:read', 'market:write', 'receipts:read'];

  const defs = [
    [actorA, 'assetA', 'assetB', 'Asset A'],
    [actorB, 'assetB', 'assetC', 'Asset B'],
    [actorC, 'assetC', 'assetA', 'Asset C']
  ];
  for (const [actorRef, giveAsset, wantAsset, title] of defs) {
    await api({
      baseUrl, actorRef, scopes, method: 'POST', pathName: '/market/listings', idempotencyKey: key(`cycle-${giveAsset}`),
      body: {
        recorded_at: nowIso(),
        listing: {
          listing_id: `${giveAsset}_${Date.now()}`,
          workspace_id: workspaceId,
          kind: 'post',
          title,
          offer: [{ platform: 'steam', asset_id: giveAsset, metadata: { category: 'games' }, estimated_value_usd: 10 }],
          want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: `steam:${wantAsset}` }] },
          valuation_hint: { usd_total: 10 }
        }
      }
    });
  }

  const computed = await api({
    baseUrl, actorRef: actorA, scopes, method: 'POST', pathName: '/market/candidates/compute', idempotencyKey: key('cycle-compute'),
    body: { workspace_id: workspaceId, max_cycle_length: 4, max_candidates: 10, recorded_at: nowIso() }
  });
  const candidate = computed.body.candidates.find(row => row.candidate_type === 'cycle');
  if (!candidate) throw new Error('cycle candidate not found');
  const planCreated = await api({
    baseUrl, actorRef: actorA, scopes, method: 'POST',
    pathName: `/market/execution-plans/from-candidate/${candidate.candidate_id}`,
    idempotencyKey: key('cycle-plan'),
    body: { recorded_at: nowIso() }
  });
  const planId = planCreated.body.plan.plan_id;
  await api({ baseUrl, actorRef: actorA, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('cycle-accept-a'), body: { recorded_at: nowIso() } });
  await api({ baseUrl, actorRef: actorB, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('cycle-accept-b'), body: { recorded_at: nowIso() } });
  await api({ baseUrl, actorRef: actorC, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('cycle-accept-c'), body: { recorded_at: nowIso() } });
  const started = await api({ baseUrl, actorRef: actorA, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/start-settlement`, idempotencyKey: key('cycle-start'), body: { settlement_mode: 'cycle_bridge', recorded_at: nowIso() } });

  for (const leg of started.body.plan.transfer_legs) {
    await api({
      baseUrl,
      actorRef: leg.from_actor,
      scopes,
      method: 'POST',
      pathName: `/market/execution-plans/${planId}/complete-leg/${leg.leg_id}`,
      idempotencyKey: key(`cycle-complete-${leg.leg_id}`),
      body: { verification_result: { status: 'ok' }, recorded_at: nowIso() }
    });
  }
  const receipt = await api({ baseUrl, actorRef: actorA, scopes, method: 'GET', pathName: `/market/execution-plans/${planId}/receipt` });
  return { workspace_id: workspaceId, candidate_id: candidate.candidate_id, plan_id: planId, receipt_id: receipt.body.receipt.id };
}

async function main() {
  const rootDir = process.cwd();
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'swapgraph-agent-market-loop-'));
  const port = 3300 + Math.floor(Math.random() * 200);
  const stateFile = path.join(tmpRoot, 'runtime-state.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime = startRuntime({ rootDir, port, stateFile });
  const evidenceDir = path.join(rootDir, 'docs', 'evidence', 'market-vnext');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, 'agent-market-loop.latest.json');

  try {
    await waitForHealth(baseUrl);
    const direct = await runDirectFlow(baseUrl);
    const mixed = await runMixedFlow(baseUrl);
    const cycle = await runCycleFlow(baseUrl);
    const out = {
      ok: true,
      checked_at: nowIso(),
      base_url: baseUrl,
      direct,
      mixed,
      cycle
    };
    writeFileSync(evidencePath, `${JSON.stringify(out, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    stopRuntime(runtime.child);
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
