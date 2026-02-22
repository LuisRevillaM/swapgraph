import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import { LiquidityInventoryService } from '../src/service/liquidityInventoryService.mjs';
import {
  verifyPolicyAuditExportPayload,
  verifyPolicyAuditExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M105';
const SCENARIO_FILE = 'fixtures/release/m105_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m105_expected.json';
const OUTPUT_FILE = 'liquidity_inventory_output.json';

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

function firstFailedReason(outcomes) {
  if (!Array.isArray(outcomes)) return null;
  const row = outcomes.find(entry => entry?.ok === false);
  return row?.reason_code ?? null;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

store.state.idempotency ||= {};
store.state.liquidity_inventory_snapshots ||= {};
store.state.liquidity_inventory_assets ||= {};
store.state.liquidity_inventory_reservations ||= {};
store.state.liquidity_inventory_reconciliation_events ||= [];
store.state.liquidity_inventory_snapshot_counter ||= 0;
store.state.liquidity_inventory_reservation_counter ||= 0;
store.state.liquidity_inventory_reconciliation_counter ||= 0;

const keysService = new PolicyIntegritySigningService();
const service = new LiquidityInventoryService({ store });

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
  const providerId = op.provider_id_ref ? refs.get(op.provider_id_ref) : op.provider_id;
  const query = fillQueryRefs(op.query ?? {}, op, exportRefs);

  let response;
  let replayed = null;

  if (op.op === 'liquidityInventory.snapshot.record') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.recordSnapshot({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityInventory.assets.list') {
    response = service.listAssets({ actor, auth, providerId, query: query ?? {} });
  } else if (op.op === 'liquidityInventory.availability.get') {
    response = service.getAvailability({ actor, auth, providerId, query: query ?? {} });
  } else if (op.op === 'liquidityInventory.reserve.batch') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.reserveBatch({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityInventory.release.batch') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.releaseBatch({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityInventory.reconciliation.export') {
    response = service.exportReconciliation({ actor, auth, providerId, query });
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

  if (op.op === 'liquidityInventory.snapshot.record' && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.snapshot_id = response.body.snapshot?.snapshot_id ?? null;
    rec.snapshot_assets_count = response.body.snapshot?.assets?.length ?? 0;
    if (typeof op.save_provider_ref === 'string') {
      refs.set(op.save_provider_ref, rec.provider_id);
    }
  }

  if (op.op === 'liquidityInventory.assets.list' && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.assets_count = response.body.assets?.length ?? 0;
    rec.first_holding_id = response.body.assets?.[0]?.holding_id ?? null;
  }

  if (op.op === 'liquidityInventory.availability.get' && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.assets_count = response.body.assets?.length ?? 0;
    rec.available_assets_count = response.body.summary?.available_assets_count ?? null;
    rec.reserved_assets_count = response.body.summary?.reserved_assets_count ?? null;
    rec.in_settlement_assets_count = response.body.summary?.in_settlement_assets_count ?? null;
    rec.not_available_assets_count = response.body.summary?.not_available_assets_count ?? null;
  }

  if (op.op === 'liquidityInventory.reserve.batch' && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.requested_count = response.body.summary?.requested_count ?? null;
    rec.success_count = response.body.summary?.success_count ?? null;
    rec.conflict_count = response.body.summary?.conflict_count ?? null;
    rec.not_available_count = response.body.summary?.not_available_count ?? null;
    rec.context_mismatch_count = response.body.summary?.context_mismatch_count ?? null;
    rec.asset_not_found_count = response.body.summary?.asset_not_found_count ?? null;
    rec.active_reservations_count = response.body.summary?.active_reservations_count ?? null;
    rec.first_failed_reason = firstFailedReason(response.body.outcomes);
  }

  if (op.op === 'liquidityInventory.release.batch' && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.requested_count = response.body.summary?.requested_count ?? null;
    rec.success_count = response.body.summary?.success_count ?? null;
    rec.context_mismatch_count = response.body.summary?.context_mismatch_count ?? null;
    rec.asset_not_found_count = response.body.summary?.asset_not_found_count ?? null;
    rec.active_reservations_count = response.body.summary?.active_reservations_count ?? null;
    rec.first_failed_reason = firstFailedReason(response.body.outcomes);
  }

  if (op.op === 'liquidityInventory.reconciliation.export' && response.ok) {
    const payload = response.body.export;
    rec.provider_id = response.body.provider_id ?? null;
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

store.save();

const snapshotsCount = Object.values(store.state.liquidity_inventory_snapshots ?? {})
  .reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
const assetsCount = Object.values(store.state.liquidity_inventory_assets ?? {})
  .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
const reservations = Object.values(store.state.liquidity_inventory_reservations ?? {});

const final = {
  liquidity_inventory_snapshots_count: snapshotsCount,
  liquidity_inventory_assets_count: assetsCount,
  liquidity_inventory_reservations_count: reservations.length,
  liquidity_inventory_active_reservations_count: reservations.filter(row => row?.status === 'reserved' || row?.status === 'in_settlement').length,
  liquidity_inventory_reconciliation_events_count: Array.isArray(store.state.liquidity_inventory_reconciliation_events) ? store.state.liquidity_inventory_reconciliation_events.length : 0,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length
};

const out = canonicalize({
  operations,
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
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
