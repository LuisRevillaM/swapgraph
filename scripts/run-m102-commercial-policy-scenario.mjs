import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import { CommercialPolicyService } from '../src/service/commercialPolicyService.mjs';
import {
  verifyPolicyAuditExportPayload,
  verifyPolicyAuditExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M102';
const SCENARIO_FILE = 'fixtures/release/m102_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m102_expected.json';
const OUTPUT_FILE = 'commercial_policy_output.json';

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
store.state.idempotency ||= {};
store.state.commercial_policies ||= {};
store.state.commercial_policy_audit ||= [];
store.state.commercial_policy_export_checkpoints ||= {};

const keysService = new PolicyIntegritySigningService();
const service = new CommercialPolicyService({ store });

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
  let response;
  let replayed = null;

  if (op.op === 'commercialPolicy.transaction_fee.get') {
    response = service.getTransactionFeePolicy({ actor, auth });
  } else if (op.op === 'commercialPolicy.transaction_fee.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertTransactionFeePolicy({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'commercialPolicy.subscription_tier.get') {
    response = service.getSubscriptionTierPolicy({ actor, auth });
  } else if (op.op === 'commercialPolicy.subscription_tier.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertSubscriptionTierPolicy({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'commercialPolicy.boost_policy.get') {
    response = service.getBoostPolicy({ actor, auth });
  } else if (op.op === 'commercialPolicy.boost_policy.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertBoostPolicy({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'commercialPolicy.quota_policy.get') {
    response = service.getQuotaPolicy({ actor, auth });
  } else if (op.op === 'commercialPolicy.quota_policy.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertQuotaPolicy({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'commercialPolicy.evaluate') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.evaluatePolicy({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'commercialPolicy.export') {
    const query = fillQueryRefs(op.query ?? {}, op, exportRefs);
    response = service.exportPolicies({ actor, auth, query });
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

  if ((op.op === 'commercialPolicy.transaction_fee.get' || op.op === 'commercialPolicy.transaction_fee.upsert') && response.ok) {
    rec.policy_version = response.body.policy?.version ?? null;
    rec.fee_model = response.body.policy?.fee_model ?? null;
    rec.fee_bps = response.body.policy?.fee_bps ?? null;
    rec.max_fee_usd = response.body.policy?.max_fee_usd ?? null;
  }

  if ((op.op === 'commercialPolicy.subscription_tier.get' || op.op === 'commercialPolicy.subscription_tier.upsert') && response.ok) {
    rec.policy_version = response.body.policy?.version ?? null;
    rec.tier = response.body.policy?.tier ?? null;
    rec.trust_milestone_required = response.body.policy?.trust_milestone_required ?? null;
    rec.max_open_intents = response.body.policy?.max_open_intents ?? null;
  }

  if ((op.op === 'commercialPolicy.boost_policy.get' || op.op === 'commercialPolicy.boost_policy.upsert') && response.ok) {
    rec.policy_version = response.body.policy?.version ?? null;
    rec.enabled = response.body.policy?.enabled ?? null;
    rec.max_multiplier = response.body.policy?.max_multiplier ?? null;
  }

  if ((op.op === 'commercialPolicy.quota_policy.get' || op.op === 'commercialPolicy.quota_policy.upsert') && response.ok) {
    rec.policy_version = response.body.policy?.version ?? null;
    rec.monthly_quota_units = response.body.policy?.monthly_quota_units ?? null;
    rec.overage_enabled = response.body.policy?.overage_enabled ?? null;
    rec.hard_stop_on_quota_exceeded = response.body.policy?.hard_stop_on_quota_exceeded ?? null;
  }

  if (op.op === 'commercialPolicy.evaluate' && response.ok) {
    rec.evaluation_id = response.body.evaluation?.evaluation_id ?? null;
    rec.verdict = response.body.evaluation?.verdict ?? null;
    rec.enforced_precedence = response.body.evaluation?.enforced_precedence ?? null;
    rec.projected_quota_usage_units = response.body.evaluation?.projected_quota_usage_units ?? null;
    rec.quota_remaining_units = response.body.evaluation?.quota_remaining_units ?? null;
  }

  if (op.op === 'commercialPolicy.export' && response.ok) {
    rec.entries_count = response.body.entries?.length ?? 0;
    rec.total_filtered = response.body.total_filtered ?? null;
    rec.next_cursor = response.body.next_cursor ?? null;
    rec.next_cursor_present = typeof response.body.next_cursor === 'string' && response.body.next_cursor.length > 0;
    rec.first_policy_type = response.body.entries?.[0]?.policy_type ?? null;
    rec.last_policy_type = response.body.entries?.[(response.body.entries?.length ?? 1) - 1]?.policy_type ?? null;

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
        tampered.entries[0].summary = { ...(tampered.entries[0].summary ?? {}), _tampered: true };
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
        checkpoint_after: response.body.checkpoint?.checkpoint_hash ?? null,
        payload: clone(response.body)
      });
    }
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const final = {
  commercial_policy_partners: Object.keys(store.state.commercial_policies ?? {}).sort(),
  commercial_policy_audit_count: Array.isArray(store.state.commercial_policy_audit) ? store.state.commercial_policy_audit.length : 0,
  commercial_policy_export_checkpoint_count: Object.values(store.state.commercial_policy_export_checkpoints ?? {})
    .reduce((sum, row) => sum + Object.keys(row ?? {}).length, 0),
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length,
  export_refs: Array.from(exportRefs.entries()).map(([name, value]) => ({
    name,
    next_cursor: value.next_cursor,
    attestation_after: value.attestation_after,
    checkpoint_after: value.checkpoint_after
  }))
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
