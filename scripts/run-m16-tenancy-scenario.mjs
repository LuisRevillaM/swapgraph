import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { createRuntimeApiServer } from '../src/server/runtimeApiServer.mjs';
import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M16 runtime tenancy scenario');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function actorFromOperation({ op, actors }) {
  if (op?.actor && op.actor.type && op.actor.id) return op.actor;
  if (op?.actor_ref) {
    const actor = actors[op.actor_ref];
    if (actor?.type && actor.id) return actor;
    throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  }
  throw new Error(`operation actor is required for op=${op?.op}`);
}

function methodForOperation(opId) {
  if (opId === 'settlement.instructions' || opId === 'settlement.status' || opId === 'receipts.get') return 'GET';
  return 'POST';
}

function pathForOperation({ opId, cycleId }) {
  if (opId === 'cycleProposals.accept') return `/cycle-proposals/${encodeURIComponent(cycleId)}/accept`;
  if (opId === 'settlement.start') return `/settlement/${encodeURIComponent(cycleId)}/start`;
  if (opId === 'settlement.deposit_confirmed') return `/settlement/${encodeURIComponent(cycleId)}/deposit-confirmed`;
  if (opId === 'settlement.begin_execution') return `/settlement/${encodeURIComponent(cycleId)}/begin-execution`;
  if (opId === 'settlement.complete') return `/settlement/${encodeURIComponent(cycleId)}/complete`;
  if (opId === 'settlement.instructions') return `/settlement/${encodeURIComponent(cycleId)}/instructions`;
  if (opId === 'settlement.status') return `/settlement/${encodeURIComponent(cycleId)}/status`;
  if (opId === 'receipts.get') return `/receipts/${encodeURIComponent(cycleId)}`;
  throw new Error(`unsupported op: ${opId}`);
}

function validateResponseSchema({ opId, responseBody, ok, endpointsByOp, validateBySchemaFile }) {
  if (ok) {
    const endpoint = endpointsByOp.get(opId);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${opId}`);
    if (!endpoint.response_schema) return;
    const v = validateBySchemaFile(endpoint.response_schema, responseBody);
    if (!v.ok) throw new Error(`response invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
    return;
  }

  const verr = validateBySchemaFile('ErrorResponse.schema.json', responseBody);
  if (!verr.ok) throw new Error(`error invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

function loadStoreState(filePath) {
  const s = new JsonStateStore({ filePath });
  s.load();
  return s.state;
}

function updateStoreState(filePath, mutator) {
  const s = new JsonStateStore({ filePath });
  s.load();
  mutator(s.state);
  s.save();
  return s.state;
}

function inferReplay({ op, cycleId, actor, preState }) {
  if (op.op === 'settlement.start') return !!preState.timelines?.[cycleId];
  if (op.op === 'settlement.deposit_confirmed') {
    const timeline = preState.timelines?.[cycleId];
    const leg = (timeline?.legs ?? []).find(row => row?.from_actor?.type === actor.type && row?.from_actor?.id === actor.id);
    if (!leg) return false;
    return leg.status === 'deposited' && leg.deposit_ref === op.deposit_ref;
  }
  return false;
}

// Load schemas
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateBySchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

// API manifest
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(endpoint => [endpoint.operation_id, endpoint]));

function scopesForOperation(op) {
  if (Array.isArray(op?.scopes)) return op.scopes;
  const endpoint = endpointsByOp.get(op?.op);
  if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op?.op}`);
  const required = endpoint?.auth?.required_scopes;
  return Array.isArray(required) ? required : [];
}

function isReadOperation(opId) {
  return opId === 'settlement.instructions' || opId === 'settlement.status' || opId === 'receipts.get';
}

async function startRuntime({ storeFile }) {
  const runtime = createRuntimeApiServer({
    host: '127.0.0.1',
    port: 0,
    stateBackend: 'json',
    storePath: storeFile
  });
  await runtime.listen();
  return runtime;
}

async function invokeRuntimeOperation({ runtime, opId, cycleId, actor, body, scopes, idempotencyKey }) {
  const method = methodForOperation(opId);
  const url = `http://${runtime.host}:${runtime.port}${pathForOperation({ opId, cycleId })}`;
  const headers = {
    accept: 'application/json',
    'x-actor-type': actor.type,
    'x-actor-id': actor.id
  };
  if (Array.isArray(scopes) && scopes.length > 0) headers['x-auth-scopes'] = scopes.join(' ');
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  const responseBody = raw ? JSON.parse(raw) : {};
  const ok = response.status >= 200 && response.status < 300;
  return { status: response.status, ok, responseBody };
}

// Seed inputs
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposal = (matchingOut.proposals ?? []).find(p => p.participants?.length === 3);
if (!proposal) throw new Error('expected a 3-cycle proposal in fixtures');
const proposalByRef = { p3: proposal };

const scenario = readJson(path.join(root, 'fixtures/settlement/m16_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m16_expected.json'));
const actors = scenario.actors ?? {};
if (!actors.partner_a?.id || actors.partner_a.type !== 'partner') {
  throw new Error('scenario.actors.partner_a must be a partner actor');
}
if (!actors.partner_b?.id || actors.partner_b.type !== 'partner') {
  throw new Error('scenario.actors.partner_b must be a partner actor');
}

const storeFile = path.join(outDir, 'store.json');
const seedStore = new JsonStateStore({ filePath: storeFile });
seedStore.load();

for (const it of matchingInput.intents) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateBySchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  seedStore.state.intents[intent.id] = intent;
}

const proposalValidation = validateBySchemaFile('CycleProposal.schema.json', proposal);
if (!proposalValidation.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(proposalValidation.errors)}`);
seedStore.state.proposals[proposal.id] = clone(proposal);
seedStore.state.tenancy ||= {};
seedStore.state.tenancy.proposals ||= {};
seedStore.state.tenancy.proposals[proposal.id] = { partner_id: actors.partner_a.id };
seedStore.save();

const operations = [];

// Main scenario via runtime API.
{
  const runtime = await startRuntime({ storeFile });
  try {
    for (const op of scenario.operations) {
      const proposalRef = proposalByRef[op.proposal_ref];
      if (!proposalRef) throw new Error(`unknown proposal_ref: ${op.proposal_ref}`);
      const cycleId = proposalRef.id;
      const actor = actorFromOperation({ op, actors });
      const preState = loadStoreState(storeFile);
      const replayed = inferReplay({ op, cycleId, actor, preState });
      const scopes = scopesForOperation(op);

      let body;
      if (op.op === 'cycleProposals.accept') {
        body = { proposal_id: cycleId, occurred_at: op.occurred_at };
      } else if (op.op === 'settlement.start') {
        body = {
          deposit_deadline_at: scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at,
          occurred_at: op.occurred_at
        };
      } else if (op.op === 'settlement.deposit_confirmed') {
        body = { deposit_ref: op.deposit_ref, occurred_at: op.occurred_at };
      } else if (op.op === 'settlement.begin_execution') {
        body = { occurred_at: op.occurred_at };
      } else if (op.op === 'settlement.complete') {
        body = { occurred_at: op.occurred_at };
      }

      const result = await invokeRuntimeOperation({
        runtime,
        opId: op.op,
        cycleId,
        actor,
        body,
        scopes,
        idempotencyKey: op.idempotency_key
      });

      validateResponseSchema({
        opId: op.op,
        responseBody: result.responseBody,
        ok: result.ok,
        endpointsByOp,
        validateBySchemaFile
      });

      if (!result.ok && !isReadOperation(op.op)) {
        throw new Error(`operation failed: op=${op.op} status=${result.status} body=${JSON.stringify(result.responseBody)}`);
      }

      if (op.op === 'cycleProposals.accept') {
        operations.push({
          op: op.op,
          cycle_id: cycleId,
          ok: result.ok,
          error_code: result.ok ? null : result.responseBody?.error?.code ?? null,
          commit_phase: result.ok ? result.responseBody?.commit?.phase ?? null : null
        });
        continue;
      }

      if (op.op === 'settlement.start' || op.op === 'settlement.deposit_confirmed') {
        operations.push({
          op: op.op,
          cycle_id: cycleId,
          ok: result.ok,
          replayed,
          timeline_state: result.responseBody?.timeline?.state ?? null
        });
        continue;
      }

      if (op.op === 'settlement.begin_execution') {
        operations.push({
          op: op.op,
          cycle_id: cycleId,
          ok: result.ok,
          timeline_state: result.responseBody?.timeline?.state ?? null
        });
        continue;
      }

      if (op.op === 'settlement.complete') {
        operations.push({
          op: op.op,
          cycle_id: cycleId,
          ok: result.ok,
          timeline_state: result.responseBody?.timeline?.state ?? null,
          receipt_id: result.responseBody?.receipt?.id ?? null,
          receipt_final_state: result.responseBody?.receipt?.final_state ?? null
        });
        continue;
      }

      if (isReadOperation(op.op)) {
        operations.push({
          op: op.op,
          cycle_id: cycleId,
          actor,
          ok: result.ok,
          error_code: result.ok ? null : result.responseBody?.error?.code ?? null
        });
        continue;
      }

      throw new Error(`unsupported op: ${op.op}`);
    }
  } finally {
    await runtime.close();
  }
}

// Replay scope self-heal and replay guard checks via runtime API.
{
  const proposalRef = proposalByRef.p3;
  const cycleId = proposalRef.id;
  const originalScope = clone(loadStoreState(storeFile).tenancy?.cycles?.[cycleId] ?? null);

  updateStoreState(storeFile, state => {
    state.tenancy ||= {};
    state.tenancy.cycles ||= {};
    delete state.tenancy.cycles[cycleId];
  });

  let scopeAfterSelfHeal = null;
  {
    const runtime = await startRuntime({ storeFile });
    try {
      const opId = 'settlement.start';
      const result = await invokeRuntimeOperation({
        runtime,
        opId,
        cycleId,
        actor: actors.partner_a,
        scopes: scopesForOperation({ op: opId }),
        body: {
          deposit_deadline_at: scenario.cycles?.p3?.deposit_deadline_at,
          occurred_at: '2026-02-16T00:09:58Z'
        }
      });

      validateResponseSchema({
        opId,
        responseBody: result.responseBody,
        ok: result.ok,
        endpointsByOp,
        validateBySchemaFile
      });

      if (!result.ok) {
        throw new Error(`replay self-heal start failed: status=${result.status} body=${JSON.stringify(result.responseBody)}`);
      }
    } finally {
      await runtime.close();
    }
    scopeAfterSelfHeal = loadStoreState(storeFile).tenancy?.cycles?.[cycleId] ?? null;
  }

  if (scopeAfterSelfHeal?.partner_id !== actors.partner_a.id) {
    throw new Error(`replay self-heal did not restore cycle tenancy: ${JSON.stringify(scopeAfterSelfHeal)}`);
  }

  operations.push({
    op: 'settlement.start.replay_scope_self_heal',
    cycle_id: cycleId,
    actor: actors.partner_a,
    ok: true,
    replayed: true,
    scope_after_partner_id: scopeAfterSelfHeal?.partner_id ?? null
  });

  updateStoreState(storeFile, state => {
    state.tenancy ||= {};
    state.tenancy.cycles ||= {};
    delete state.tenancy.cycles[cycleId];
  });

  let replayOk = false;
  let replayErrorCode = null;
  let scopeAfterReplay = null;
  {
    const runtime = await startRuntime({ storeFile });
    try {
      const opId = 'settlement.start';
      const result = await invokeRuntimeOperation({
        runtime,
        opId,
        cycleId,
        actor: actors.partner_b,
        scopes: scopesForOperation({ op: opId }),
        body: {
          deposit_deadline_at: scenario.cycles?.p3?.deposit_deadline_at,
          occurred_at: '2026-02-16T00:09:59Z'
        }
      });

      validateResponseSchema({
        opId,
        responseBody: result.responseBody,
        ok: result.ok,
        endpointsByOp,
        validateBySchemaFile
      });

      replayOk = result.ok;
      replayErrorCode = result.ok ? null : result.responseBody?.error?.code ?? null;
    } finally {
      await runtime.close();
    }
    scopeAfterReplay = loadStoreState(storeFile).tenancy?.cycles?.[cycleId] ?? null;
  }

  if (replayOk) {
    throw new Error('replay guard unexpectedly succeeded');
  }
  if (replayErrorCode !== 'FORBIDDEN') {
    throw new Error(`replay guard expected FORBIDDEN, got ${replayErrorCode}`);
  }
  if (scopeAfterReplay?.partner_id) {
    throw new Error(`replay start rebound cycle tenancy: ${JSON.stringify(scopeAfterReplay)}`);
  }

  updateStoreState(storeFile, state => {
    state.tenancy ||= {};
    state.tenancy.cycles ||= {};
    if (originalScope) {
      state.tenancy.cycles[cycleId] = originalScope;
    } else {
      delete state.tenancy.cycles[cycleId];
    }
  });

  operations.push({
    op: 'settlement.start.replay_scope_guard',
    cycle_id: cycleId,
    actor: actors.partner_b,
    ok: replayOk,
    error_code: replayErrorCode,
    scope_after_partner_id: scopeAfterReplay?.partner_id ?? null
  });
}

const finalState = loadStoreState(storeFile);
const out = canonicalize({
  operations,
  tenancy: finalState.tenancy
});

writeFileSync(path.join(outDir, 'tenancy_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M16', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
