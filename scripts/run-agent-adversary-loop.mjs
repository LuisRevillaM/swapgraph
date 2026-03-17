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

function headers({ actorRef, scopes, idempotencyKey }) {
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
    headers: headers({ actorRef, scopes, idempotencyKey }),
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
  return child;
}

function stopRuntime(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

function configuredBaseUrl() {
  const raw = process.env.SWAPGRAPH_BASE_URL ?? process.env.MARKET_EXPERIMENT_BASE_URL ?? '';
  return typeof raw === 'string' && raw.trim() ? raw.trim().replace(/\/+$/g, '') : null;
}

function key(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  const rootDir = process.cwd();
  const configured = configuredBaseUrl();
  const tmpRoot = configured ? null : mkdtempSync(path.join(tmpdir(), 'swapgraph-agent-adversary-loop-'));
  const port = configured ? null : 3500 + Math.floor(Math.random() * 200);
  const stateFile = configured ? null : path.join(tmpRoot, 'runtime-state.json');
  const baseUrl = configured ?? `http://127.0.0.1:${port}`;
  const runtime = configured ? null : startRuntime({ rootDir, port, stateFile });
  const evidenceDir = path.join(rootDir, 'docs', 'evidence', 'market-vnext');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, 'agent-adversary-loop.latest.json');

  const buyer = actor('user', `adversary_buyer_${Date.now()}`);
  const seller = actor('user', `adversary_seller_${Date.now()}`);
  const outsider = actor('user', `adversary_outsider_${Date.now()}`);
  const scopes = ['market:read', 'market:write', 'receipts:read'];

  try {
    await waitForHealth(baseUrl);
    const workspaceId = `agent_adversary_${Date.now()}`;

    const blueprint = await api({
      baseUrl, actorRef: seller, scopes, method: 'POST', pathName: '/market/blueprints', idempotencyKey: key('adv-blueprint'),
      body: {
        recorded_at: nowIso(),
        blueprint: {
          blueprint_id: `bp_adv_${Date.now()}`,
          workspace_id: workspaceId,
          title: 'Adversary blueprint',
          category: 'workflow',
          artifact_ref: 'https://example.com/adversary-blueprint.tgz',
          artifact_format: 'tarball',
          delivery_mode: 'download',
          pricing_model: 'one_time',
          valuation_hint: { usd_amount: 20 }
        }
      }
    });
    await api({ baseUrl, actorRef: seller, scopes, method: 'POST', pathName: `/market/blueprints/${blueprint.body.blueprint.blueprint_id}/publish`, idempotencyKey: key('adv-publish'), body: { recorded_at: nowIso() } });
    await api({
      baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: '/market/listings', idempotencyKey: key('adv-want'),
      body: {
        recorded_at: nowIso(),
        listing: {
          listing_id: `want_adv_${Date.now()}`,
          workspace_id: workspaceId,
          kind: 'want',
          title: 'Need adversary blueprint',
          want_spec: { type: 'set', any_of: [{ type: 'category', category: 'blueprint:workflow' }] },
          budget: { amount: 20, currency: 'USD' }
        }
      }
    });

    const computed = await api({
      baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: '/market/candidates/compute', idempotencyKey: key('adv-compute'),
      body: { workspace_id: workspaceId, max_cycle_length: 3, max_candidates: 10, recorded_at: nowIso() }
    });
    const candidate = computed.body.candidates.find(row => row.candidate_type === 'mixed');
    if (!candidate) throw new Error('adversary candidate not found');

    const replayRecordedAt = nowIso();
    const planFirst = await api({
      baseUrl, actorRef: buyer, scopes, method: 'POST',
      pathName: `/market/execution-plans/from-candidate/${candidate.candidate_id}`,
      idempotencyKey: 'adv-plan-replay',
      body: { recorded_at: replayRecordedAt }
    });
    const planReplay = await api({
      baseUrl, actorRef: buyer, scopes, method: 'POST',
      pathName: `/market/execution-plans/from-candidate/${candidate.candidate_id}`,
      idempotencyKey: 'adv-plan-replay',
      body: { recorded_at: replayRecordedAt }
    });
    const planId = planFirst.body.plan.plan_id;

    const outsiderAccept = await api({
      baseUrl, actorRef: outsider, scopes, method: 'POST',
      pathName: `/market/execution-plans/${planId}/accept`,
      idempotencyKey: key('adv-outsider-accept'),
      body: { recorded_at: nowIso() },
      allowFailure: true
    });

    await api({ baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('adv-accept-buyer'), body: { recorded_at: nowIso() } });
    await api({ baseUrl, actorRef: seller, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/accept`, idempotencyKey: key('adv-accept-seller'), body: { recorded_at: nowIso() } });
    const started = await api({ baseUrl, actorRef: buyer, scopes, method: 'POST', pathName: `/market/execution-plans/${planId}/start-settlement`, idempotencyKey: key('adv-start'), body: { settlement_mode: 'external_payment_proof', recorded_at: nowIso() } });
    const cashLeg = started.body.plan.transfer_legs.find(row => row.leg_type === 'cash_payment');
    const blueprintLeg = started.body.plan.transfer_legs.find(row => row.leg_type === 'blueprint_delivery');
    if (!cashLeg || !blueprintLeg) throw new Error('expected cash and blueprint legs for adversary scenario');

    await api({
      baseUrl, actorRef: buyer, scopes, method: 'POST',
      pathName: `/market/execution-plans/${planId}/complete-leg/${cashLeg.leg_id}`,
      idempotencyKey: key('adv-complete-cash'),
      body: { verification_result: { payment_confirmed: true }, recorded_at: nowIso() }
    });

    const outsiderComplete = await api({
      baseUrl, actorRef: outsider, scopes, method: 'POST',
      pathName: `/market/execution-plans/${planId}/complete-leg/${blueprintLeg.leg_id}`,
      idempotencyKey: key('adv-outsider-complete'),
      body: { verification_result: { status: 'ok' }, recorded_at: nowIso() },
      allowFailure: true
    });

    const unwound = await api({
      baseUrl, actorRef: seller, scopes, method: 'POST',
      pathName: `/market/execution-plans/${planId}/fail-leg/${blueprintLeg.leg_id}`,
      idempotencyKey: key('adv-fail-blueprint'),
      body: { failure_reason: 'artifact_missing', recorded_at: nowIso() }
    });

    const duplicateFailure = await api({
      baseUrl, actorRef: seller, scopes, method: 'POST',
      pathName: `/market/execution-plans/${planId}/fail-leg/${blueprintLeg.leg_id}`,
      idempotencyKey: key('adv-fail-blueprint-2'),
      body: { failure_reason: 'artifact_missing', recorded_at: nowIso() },
      allowFailure: true
    });

    const receipt = await api({ baseUrl, actorRef: buyer, scopes, method: 'GET', pathName: `/market/execution-plans/${planId}/receipt` });
    await api({
      baseUrl,
      actorRef: seller,
      scopes,
      method: 'POST',
      pathName: `/market/blueprints/${blueprint.body.blueprint.blueprint_id}/archive`,
      idempotencyKey: key('adv-archive'),
      body: { recorded_at: nowIso() }
    });

    const out = {
      ok: true,
      checked_at: nowIso(),
      mode: configured ? 'hosted' : 'local',
      replay_same_plan_id: planFirst.body.plan.plan_id === planReplay.body.plan.plan_id,
      outsider_accept_status: outsiderAccept.status,
      outsider_complete_status: outsiderComplete.status,
      duplicate_failure_status: duplicateFailure.status,
      final_plan_status: unwound.body.plan.status,
      final_receipt_state: receipt.body.receipt.final_state
    };

    if (!out.replay_same_plan_id) throw new Error('idempotent replay did not return the same plan id');
    if (out.outsider_accept_status !== 403) throw new Error(`expected outsider accept 403, got ${out.outsider_accept_status}`);
    if (out.outsider_complete_status !== 403) throw new Error(`expected outsider complete 403, got ${out.outsider_complete_status}`);
    if (![400, 409].includes(out.duplicate_failure_status)) throw new Error(`expected duplicate failure 400/409, got ${out.duplicate_failure_status}`);
    if (out.final_plan_status !== 'unwound') throw new Error(`expected unwound final status, got ${out.final_plan_status}`);
    if (out.final_receipt_state !== 'unwound') throw new Error(`expected unwound receipt, got ${out.final_receipt_state}`);

    writeFileSync(evidencePath, `${JSON.stringify(out, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    if (runtime) stopRuntime(runtime);
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
