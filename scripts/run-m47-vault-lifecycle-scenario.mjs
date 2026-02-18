import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { VaultLifecycleService } from '../src/vault/vaultLifecycleService.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const actorRefSchema = readJson(path.join(schemasDir, 'ActorRef.schema.json'));
const assetRefSchema = readJson(path.join(schemasDir, 'AssetRef.schema.json'));
const vaultHoldingSchema = readJson(path.join(schemasDir, 'VaultHolding.schema.json'));
const vaultEventSchema = readJson(path.join(schemasDir, 'VaultEvent.schema.json'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(actorRefSchema);
ajv.addSchema(assetRefSchema);
ajv.addSchema(vaultHoldingSchema);
ajv.addSchema(vaultEventSchema);

const validateHolding = ajv.getSchema(vaultHoldingSchema.$id) ?? ajv.compile(vaultHoldingSchema);
const validateEvent = ajv.getSchema(vaultEventSchema.$id) ?? ajv.compile(vaultEventSchema);

const scenario = readJson(path.join(root, 'fixtures/vault/m47_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/vault/m47_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.save();

const svc = new VaultLifecycleService({ store });
const actors = scenario.actors ?? {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = actors?.[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  let replayed = null;
  let response;

  if (op.op === 'vault.deposit') {
    const r = svc.deposit({
      actor,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      nowIso: op.now_iso
    });
    replayed = r.replayed;
    response = r.result;
  } else if (op.op === 'vault.reserve') {
    const r = svc.reserve({
      actor,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      nowIso: op.now_iso
    });
    replayed = r.replayed;
    response = r.result;
  } else if (op.op === 'vault.release') {
    const r = svc.release({
      actor,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      nowIso: op.now_iso
    });
    replayed = r.replayed;
    response = r.result;
  } else if (op.op === 'vault.withdraw') {
    const r = svc.withdraw({
      actor,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      nowIso: op.now_iso
    });
    replayed = r.replayed;
    response = r.result;
  } else if (op.op === 'vault.get') {
    response = svc.get({ actor, holdingId: op.holding_id });
  } else if (op.op === 'vault.list') {
    response = svc.list({ actor, query: op.query ?? {} });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  if (response?.ok && response.body?.holding) {
    if (!validateHolding(response.body.holding)) {
      throw new Error(`holding schema invalid for op=${op.op}: ${JSON.stringify(validateHolding.errors ?? [])}`);
    }
  }

  if (response?.ok && Array.isArray(response.body?.holdings)) {
    for (const h of response.body.holdings) {
      if (!validateHolding(h)) {
        throw new Error(`list holding schema invalid for op=${op.op}: ${JSON.stringify(validateHolding.errors ?? [])}`);
      }
    }
  }

  const record = {
    op: op.op,
    actor,
    ok: !!response?.ok,
    replayed,
    error_code: response?.ok ? null : (response?.body?.error?.code ?? null),
    reason_code: response?.ok ? null : (response?.body?.error?.details?.reason_code ?? null),
    holding_id: response?.body?.holding?.holding_id ?? op?.holding_id ?? op?.request?.holding_id ?? op?.request?.holding?.holding_id ?? null,
    status: response?.ok ? (response?.body?.holding?.status ?? null) : null,
    reservation_id: response?.ok ? (response?.body?.holding?.reservation_id ?? null) : null,
    list_count: response?.ok && Array.isArray(response?.body?.holdings) ? response.body.holdings.length : null,
    list_statuses: response?.ok && Array.isArray(response?.body?.holdings) ? response.body.holdings.map(h => h.status) : null
  };

  operations.push(record);

  if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
  if (typeof op.expect_replayed === 'boolean') assert.equal(record.replayed, op.expect_replayed);
  if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
  if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
  if (op.expect_status) assert.equal(record.status, op.expect_status);
  if (Object.prototype.hasOwnProperty.call(op, 'expect_reservation_id')) assert.equal(record.reservation_id, op.expect_reservation_id);
  if (typeof op.expect_list_count === 'number') assert.equal(record.list_count, op.expect_list_count);
  if (Array.isArray(op.expect_list_statuses)) assert.deepEqual(record.list_statuses, op.expect_list_statuses);
}

store.save();

const events = store.state.vault_events ?? [];
for (const e of events) {
  if (!validateEvent(e)) {
    throw new Error(`vault event schema invalid: ${JSON.stringify(validateEvent.errors ?? [])}`);
  }
}

const holdings = Object.values(store.state.vault_holdings ?? {})
  .sort((a, b) => String(a.holding_id).localeCompare(String(b.holding_id)))
  .map(h => ({
    holding_id: h.holding_id,
    status: h.status,
    vault_id: h.vault_id,
    owner_actor: h.owner_actor,
    reservation_id: h.reservation_id ?? null,
    withdrawn_at: h.withdrawn_at ?? null
  }));

const out = canonicalize({
  operations,
  final: {
    holding_ids: holdings.map(h => h.holding_id),
    holdings,
    vault_event_count: events.length,
    vault_event_types: events.map(e => e.event_type)
  }
});

writeFileSync(path.join(outDir, 'vault_lifecycle_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M47', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, events: events.length, holdings: holdings.length } }, null, 2));
