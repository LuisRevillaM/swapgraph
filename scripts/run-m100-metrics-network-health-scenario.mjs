import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import { MetricsNetworkHealthService } from '../src/service/metricsNetworkHealthService.mjs';
import {
  verifyPolicyAuditExportPayload,
  verifyPolicyAuditExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M100';
const SCENARIO_FILE = 'fixtures/release/m100_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m100_expected.json';
const OUTPUT_FILE = 'metrics_network_health_output.json';

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

  if (typeof op.attestation_ref === 'string') {
    const ref = refs.get(op.attestation_ref);
    if (!ref?.attestation_after) throw new Error(`missing attestation ref: ${op.attestation_ref}`);
    out.attestation_after = ref.attestation_after;
  }

  if (typeof op.checkpoint_ref === 'string') {
    const ref = refs.get(op.checkpoint_ref);
    if (!ref?.checkpoint_after) throw new Error(`missing checkpoint ref: ${op.checkpoint_ref}`);
    out.checkpoint_after = ref.checkpoint_after;
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
store.state.metrics_network_health_export_checkpoints ||= {};

const keysService = new PolicyIntegritySigningService();
const metricsService = new MetricsNetworkHealthService({ store });

const operations = [];
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
  const query = fillQueryRefs(op.query ?? {}, op, exportRefs);

  let response;
  if (op.op === 'metrics.north_star.get') {
    response = metricsService.getNorthStar({ actor, auth, query });
  } else if (op.op === 'metrics.marketplace_funnel.get') {
    response = metricsService.getMarketplaceFunnel({ actor, auth, query });
  } else if (op.op === 'metrics.partner_health.get') {
    response = metricsService.getPartnerHealth({ actor, auth, query });
  } else if (op.op === 'metrics.safety_health.get') {
    response = metricsService.getSafetyHealth({ actor, auth, query });
  } else if (op.op === 'metrics.network_health.export') {
    response = metricsService.exportNetworkHealth({ actor, auth, query });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  validateApiResponse(op.op, response);

  const rec = {
    op: op.op,
    ok: response.ok,
    error_code: response.ok ? null : response.body.error.code,
    reason_code: response.ok ? null : reasonCodeFromError(response.body)
  };

  if (op.op === 'metrics.north_star.get' && response.ok) {
    rec.weekly_successful_swaps_per_active_trader = response.body.summary?.weekly_successful_swaps_per_active_trader ?? null;
    rec.fill_rate_7d_bps = response.body.summary?.fill_rate_7d_bps ?? null;
    rec.proposal_to_accept_bps = response.body.summary?.proposal_to_accept_bps ?? null;
    rec.accept_to_complete_bps = response.body.summary?.accept_to_complete_bps ?? null;
    rec.webhook_delivery_success_bps = response.body.summary?.webhook_delivery_success_bps ?? null;
    rec.fraud_flags_per_1000_intents = response.body.summary?.fraud_flags_per_1000_intents ?? null;
    rec.unwind_rate_bps = response.body.summary?.unwind_rate_bps ?? null;
  }

  if (op.op === 'metrics.marketplace_funnel.get' && response.ok) {
    rec.connect_count = response.body.funnel?.counts?.connect ?? null;
    rec.sync_count = response.body.funnel?.counts?.sync ?? null;
    rec.intent_count = response.body.funnel?.counts?.intent ?? null;
    rec.proposal_viewed_count = response.body.funnel?.counts?.proposal_viewed ?? null;
    rec.accepted_count = response.body.funnel?.counts?.accepted ?? null;
    rec.deposited_count = response.body.funnel?.counts?.deposited ?? null;
    rec.completed_count = response.body.funnel?.counts?.completed ?? null;
  }

  if (op.op === 'metrics.partner_health.get' && response.ok) {
    rec.proposal_delivery_success_bps = response.body.partner_health?.proposal_delivery_success_bps ?? null;
    rec.commit_to_completion_bps = response.body.partner_health?.commit_to_completion_bps ?? null;
    rec.webhook_delivery_success_bps = response.body.partner_health?.webhook_delivery_success_bps ?? null;
    rec.webhook_dead_letter_rate_bps = response.body.partner_health?.webhook_dead_letter_rate_bps ?? null;
  }

  if (op.op === 'metrics.safety_health.get' && response.ok) {
    rec.fraud_flags_count = response.body.safety_health?.fraud_flags_count ?? null;
    rec.confirmed_abuse_count = response.body.safety_health?.confirmed_abuse_count ?? null;
    rec.unwind_rate_bps = response.body.safety_health?.unwind_rate_bps ?? null;
    rec.felt_safe_proxy_bps = response.body.safety_health?.felt_safe_proxy_bps ?? null;
    rec.fraud_flags_per_1000_intents = response.body.safety_health?.fraud_flags_per_1000_intents ?? null;
  }

  if (op.op === 'metrics.network_health.export' && response.ok) {
    rec.entries_count = response.body.entries?.length ?? 0;
    rec.total_filtered = response.body.total_filtered ?? null;
    rec.next_cursor = response.body.next_cursor ?? null;

    const verifiedDefault = verifyPolicyAuditExportPayload(response.body);
    rec.default_verify_ok = verifiedDefault.ok;

    const keyId = response.body.signature?.key_id ?? null;
    const publicKeyPem = keyId ? (publicKeysById.get(keyId) ?? null) : null;
    if (!publicKeyPem) throw new Error(`missing public key for export signature key_id=${String(keyId)}`);

    const verifiedPublic = verifyPolicyAuditExportPayloadWithPublicKeyPem({
      payload: response.body,
      publicKeyPem,
      keyId,
      alg: response.body.signature?.alg
    });
    rec.public_key_verify_ok = verifiedPublic.ok;

    if (op.expect_tamper_fail === true) {
      const tampered = clone(response.body);
      if ((tampered.entries?.length ?? 0) > 0) {
        tampered.entries[0].unwind_rate_bps = Number(tampered.entries[0].unwind_rate_bps ?? 0) + 1;
      } else {
        tampered.total_filtered = Number(tampered.total_filtered ?? 0) + 1;
      }

      const tamperedVerify = verifyPolicyAuditExportPayload(tampered);
      rec.tamper_fail_verified = tamperedVerify.ok === false;
    }

    if (typeof op.save_export_ref === 'string') {
      exportRefs.set(op.save_export_ref, {
        next_cursor: response.body.next_cursor ?? null,
        attestation_after: response.body.attestation?.chain_hash ?? null,
        checkpoint_after: response.body.checkpoint?.checkpoint_hash ?? null
      });
    }
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const final = {
  checkpoints_count: Object.keys(store.state.metrics_network_health_export_checkpoints ?? {}).length,
  export_refs: Array.from(exportRefs.entries()).map(([name, value]) => ({ name, ...value }))
};

const out = canonicalize({ operations, final });
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
