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
  console.error('AUTHZ_ENFORCE must be 1 for M15 runtime redaction scenario');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function actorFromOperation({ op, actorRefs }) {
  if (op?.actor && op.actor.type && op.actor.id) return op.actor;
  if (op?.actor_ref) {
    const actor = actorRefs[op.actor_ref];
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
  if (!verr.ok) throw new Error(`error response invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

function loadStoreState(filePath) {
  const s = new JsonStateStore({ filePath });
  s.load();
  return s.state;
}

function inferReplay({ op, cycleId, actor, preState }) {
  if (op.op === 'cycleProposals.accept') {
    const key = `${actor.type}:${actor.id}|${op.op}|${op.idempotency_key}`;
    return Object.prototype.hasOwnProperty.call(preState.idempotency ?? {}, key);
  }
  if (op.op === 'settlement.start') {
    return !!preState.timelines?.[cycleId];
  }
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

// Seed inputs
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposal = (matchingOut.proposals ?? []).find(p => p.participants?.length === 3);
if (!proposal) throw new Error('expected a 3-cycle proposal in fixtures');
const proposalByRef = { p3: proposal };

const scenario = readJson(path.join(root, 'fixtures/settlement/m15_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m15_expected.json'));
const actorRefs = {
  actor_partner: scenario.actor_partner,
  actor_user_u1: scenario.actor_user_u1
};
if (!actorRefs.actor_partner?.id || actorRefs.actor_partner.type !== 'partner') {
  throw new Error('scenario.actor_partner must be a partner actor');
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

seedStore.state.tenancy ||= {};
seedStore.state.tenancy.proposals ||= {};
const proposalValidation = validateBySchemaFile('CycleProposal.schema.json', proposal);
if (!proposalValidation.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(proposalValidation.errors)}`);
seedStore.state.proposals[proposal.id] = clone(proposal);
seedStore.state.tenancy.proposals[proposal.id] = { partner_id: actorRefs.actor_partner.id };

function seedVaultHoldingsForCycle({ proposalValue, cycleConfig }) {
  const vaultBindings = cycleConfig?.vault_bindings;
  if (!Array.isArray(vaultBindings) || vaultBindings.length === 0) return;

  const participantByIntentId = new Map((proposalValue.participants ?? []).map(participant => [participant.intent_id, participant]));
  seedStore.state.vault_holdings ||= {};

  for (const binding of vaultBindings) {
    const participant = participantByIntentId.get(binding.intent_id);
    if (!participant) throw new Error(`vault binding intent missing from proposal: ${binding.intent_id}`);
    const asset = Array.isArray(participant.give) ? participant.give[0] : null;
    if (!asset) throw new Error(`vault binding intent has no give asset: ${binding.intent_id}`);

    seedStore.state.vault_holdings[binding.holding_id] = {
      holding_id: binding.holding_id,
      owner_actor: participant.actor,
      vault_id: `vault_${participant.actor.id}`,
      asset: clone(asset),
      status: 'reserved',
      reservation_id: binding.reservation_id,
      settlement_cycle_id: null,
      updated_at: '2026-02-16T00:00:00Z'
    };
  }
}

seedVaultHoldingsForCycle({
  proposalValue: proposal,
  cycleConfig: scenario.cycles?.p3 ?? {}
});
seedStore.save();

const runtime = createRuntimeApiServer({
  host: '127.0.0.1',
  port: 0,
  stateBackend: 'json',
  storePath: storeFile
});
await runtime.listen();

const baseUrl = `http://${runtime.host}:${runtime.port}`;
const operations = [];

try {
  for (const op of scenario.operations) {
    const proposalRef = proposalByRef[op.proposal_ref];
    if (!proposalRef) throw new Error(`unknown proposal_ref: ${op.proposal_ref}`);
    const cycleId = proposalRef.id;
    const actor = actorFromOperation({ op, actorRefs });
    const preState = loadStoreState(storeFile);
    const replayed = inferReplay({ op, cycleId, actor, preState });

    let body;
    if (op.op === 'cycleProposals.accept') {
      body = { proposal_id: cycleId, occurred_at: op.occurred_at };
    } else if (op.op === 'settlement.start') {
      body = {
        deposit_deadline_at: scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at,
        vault_bindings: scenario.cycles?.[op.proposal_ref]?.vault_bindings,
        occurred_at: op.occurred_at
      };
    } else if (op.op === 'settlement.deposit_confirmed') {
      body = { deposit_ref: op.deposit_ref, occurred_at: op.occurred_at };
    } else if (op.op === 'settlement.begin_execution') {
      body = { occurred_at: op.occurred_at };
    } else if (op.op === 'settlement.complete') {
      body = { occurred_at: op.occurred_at };
    }

    const method = methodForOperation(op.op);
    const url = `${baseUrl}${pathForOperation({ opId: op.op, cycleId })}`;
    const scopes = scopesForOperation(op);
    const headers = {
      accept: 'application/json',
      'x-actor-type': actor.type,
      'x-actor-id': actor.id
    };
    if (scopes.length > 0) headers['x-auth-scopes'] = scopes.join(' ');
    if (op.idempotency_key) headers['idempotency-key'] = op.idempotency_key;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    const responseBody = raw ? JSON.parse(raw) : {};
    const ok = response.status >= 200 && response.status < 300;

    validateResponseSchema({
      opId: op.op,
      responseBody,
      ok,
      endpointsByOp,
      validateBySchemaFile
    });

    if (!ok && !isReadOperation(op.op)) {
      throw new Error(`operation failed: op=${op.op} status=${response.status} body=${JSON.stringify(responseBody)}`);
    }

    if (op.op === 'cycleProposals.accept') {
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        ok,
        replayed,
        commit_phase: ok ? responseBody?.commit?.phase ?? null : null,
        error_code: ok ? null : responseBody?.error?.code ?? null
      });
      continue;
    }

    if (op.op === 'settlement.start' || op.op === 'settlement.deposit_confirmed') {
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        ok,
        replayed,
        timeline_state: responseBody?.timeline?.state ?? null
      });
      continue;
    }

    if (op.op === 'settlement.begin_execution') {
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        ok,
        timeline_state: responseBody?.timeline?.state ?? null
      });
      continue;
    }

    if (op.op === 'settlement.complete') {
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        ok,
        timeline_state: responseBody?.timeline?.state ?? null,
        receipt_id: responseBody?.receipt?.id ?? null,
        receipt_final_state: responseBody?.receipt?.final_state ?? null
      });
      continue;
    }

    if (isReadOperation(op.op)) {
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        actor,
        ok,
        error_code: ok ? null : responseBody?.error?.code ?? null,
        body: clone(responseBody)
      });
      continue;
    }

    throw new Error(`unsupported op: ${op.op}`);
  }
} finally {
  await runtime.close();
}

const out = canonicalize({ operations });

writeFileSync(path.join(outDir, 'redaction_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M15', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
