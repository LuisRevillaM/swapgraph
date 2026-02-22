import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import { LiquiditySimulationService } from '../src/service/liquiditySimulationService.mjs';
import {
  verifyPolicyAuditExportPayload,
  verifyPolicyAuditExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M104';
const SCENARIO_FILE = 'fixtures/release/m104_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m104_expected.json';
const OUTPUT_FILE = 'liquidity_simulation_output.json';

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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));

const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const eventPayloadByType = new Map((eventsManifest.event_types ?? []).map(et => [et.type, et.payload_schema]));

function endpointFor(opId) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint for operation_id=${opId}`);
  return endpoint;
}

function validateApiRequest(opId, requestPayload) {
  const endpoint = endpointFor(opId);
  if (!endpoint.request_schema) return;
  const v = validateAgainstSchemaFile(endpoint.request_schema, requestPayload);
  if (!v.ok) throw new Error(`request invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
}

function validateApiResponse(opId, response) {
  const endpoint = endpointFor(opId);
  if (response.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!v.ok) throw new Error(`response invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
    return;
  }
  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

function applyExpectations(op, rec) {
  for (const [k, v] of Object.entries(op)) {
    if (!k.startsWith('expect_')) continue;
    if (k === 'expect_tamper_fail') continue;
    const field = k.slice('expect_'.length);
    assert.deepEqual(rec[field], v, `expectation_failed op=${op.op} field=${field}`);
  }
}

function fillQueryRefs(query, op, refs) {
  const out = clone(query ?? {});
  if (typeof op.cursor_ref === 'string') {
    const ref = refs.get(op.cursor_ref);
    if (!ref?.next_cursor) throw new Error(`missing cursor ref: ${op.cursor_ref}`);
    out.cursor_after = ref.next_cursor;
  }
  return out;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}
store.state.liquidity_simulation_sessions ||= {};
store.state.liquidity_simulation_events ||= [];
store.state.idempotency ||= {};

const keysService = new PolicyIntegritySigningService();
const service = new LiquiditySimulationService({ store });

const operations = [];
const refs = new Map();
const exportRefs = new Map();
const publicKeysById = new Map();

for (const op of scenario.operations ?? []) {
  if (op.op === 'keys.policy_integrity_signing.get') {
    const response = keysService.getSigningKeys();
    validateApiResponse(op.op, response);

    for (const key of response.body?.keys ?? []) {
      if (typeof key?.key_id === 'string' && typeof key?.public_key_pem === 'string') {
        publicKeysById.set(key.key_id, key.public_key_pem);
      }
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      keys_count: response.ok ? (response.body.keys?.length ?? 0) : null,
      active_key_id: response.ok ? (response.body.active_key_id ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};
  const sessionId = op.session_id_ref ? refs.get(op.session_id_ref) : op.session_id;
  const query = fillQueryRefs(op.query ?? {}, op, exportRefs);

  let response;
  let replayed = null;

  if (op.op === 'liquiditySimulation.session.start') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.startSession({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquiditySimulation.session.get') {
    response = service.getSession({ actor, auth, sessionId });
  } else if (op.op === 'liquiditySimulation.session.stop') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.stopSession({ actor, auth, sessionId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquiditySimulation.intent.sync') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.syncIntents({ actor, auth, sessionId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquiditySimulation.cycle.export') {
    response = service.exportCycles({ actor, auth, sessionId, query });
  } else if (op.op === 'liquiditySimulation.receipt.export') {
    response = service.exportReceipts({ actor, auth, sessionId, query });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  validateApiResponse(op.op, response);

  const rec = {
    op: op.op,
    ok: response.ok,
    replayed,
    error_code: response.ok ? null : response.body.error.code,
    reason_code: response.ok ? null : reasonCodeFromError(response.body)
  };

  if ((op.op === 'liquiditySimulation.session.start' || op.op === 'liquiditySimulation.session.get' || op.op === 'liquiditySimulation.session.stop') && response.ok) {
    rec.session_id = response.body.session?.session_id ?? null;
    rec.session_status = response.body.session?.status ?? null;
    rec.sync_calls = response.body.session?.counters?.sync_calls ?? null;
    rec.cycles_generated_total = response.body.session?.counters?.cycles_generated_total ?? null;
    rec.receipts_generated_total = response.body.session?.counters?.receipts_generated_total ?? null;

    if (op.op === 'liquiditySimulation.session.start' && typeof op.save_session_ref === 'string') {
      refs.set(op.save_session_ref, rec.session_id);
    }
  }

  if (op.op === 'liquiditySimulation.intent.sync' && response.ok) {
    rec.session_id = response.body.session_id ?? null;
    rec.synced_intents_count = response.body.synced_intents_count ?? null;
    rec.active_intents_count = response.body.active_intents_count ?? null;
    rec.generated_cycle_id = response.body.generated_cycle_id ?? null;
    rec.generated_receipt_id = response.body.generated_receipt_id ?? null;
  }

  if ((op.op === 'liquiditySimulation.cycle.export' || op.op === 'liquiditySimulation.receipt.export') && response.ok) {
    const payload = response.body.export;
    rec.entries_count = payload?.entries?.length ?? 0;
    rec.total_filtered = payload?.total_filtered ?? null;
    rec.next_cursor = payload?.next_cursor ?? null;
    rec.next_cursor_present = typeof payload?.next_cursor === 'string' && payload.next_cursor.length > 0;

    const verifiedDefault = verifyPolicyAuditExportPayload(payload);
    rec.default_verify_ok = verifiedDefault.ok;

    const keyId = payload?.signature?.key_id ?? null;
    const publicKeyPem = keyId ? (publicKeysById.get(keyId) ?? null) : null;
    if (!publicKeyPem) throw new Error(`missing public key for export signature key_id=${String(keyId)}`);

    const verifiedPublic = verifyPolicyAuditExportPayloadWithPublicKeyPem({
      payload,
      publicKeyPem,
      keyId,
      alg: payload.signature?.alg
    });
    rec.public_key_verify_ok = verifiedPublic.ok;

    if (op.expect_tamper_fail === true) {
      const tampered = clone(payload);
      if ((tampered.entries?.length ?? 0) > 0) {
        tampered.entries[0].tampered = true;
      } else {
        tampered.total_filtered = Number(tampered.total_filtered ?? 0) + 1;
      }
      const tamperedVerify = verifyPolicyAuditExportPayload(tampered);
      rec.tamper_fail_verified = tamperedVerify.ok === false;
    }

    if (typeof op.save_export_ref === 'string') {
      exportRefs.set(op.save_export_ref, {
        next_cursor: payload?.next_cursor ?? null
      });
    }
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

const eventChecks = [];
for (const check of scenario.event_payload_checks ?? []) {
  const schemaFile = eventPayloadByType.get(check.type);
  if (!schemaFile) throw new Error(`unknown event type in check: ${check.type}`);
  const v = validateAgainstSchemaFile(schemaFile, check.payload ?? {});
  const rec = {
    type: check.type,
    schema: schemaFile,
    ok: v.ok,
    errors_count: v.errors?.length ?? 0
  };
  if (typeof check.expect_ok === 'boolean') {
    assert.equal(rec.ok, check.expect_ok, `event payload check failed for type=${check.type}`);
  }
  eventChecks.push(rec);
}

store.save();

const final = {
  liquidity_simulation_sessions_count: Object.keys(store.state.liquidity_simulation_sessions ?? {}).length,
  liquidity_simulation_events_count: Array.isArray(store.state.liquidity_simulation_events) ? store.state.liquidity_simulation_events.length : 0,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length,
  session_ids: Object.keys(store.state.liquidity_simulation_sessions ?? {}).sort()
};

const out = canonicalize({
  operations,
  event_checks: eventChecks,
  final
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, event_checks: eventChecks.length } }, null, 2));
