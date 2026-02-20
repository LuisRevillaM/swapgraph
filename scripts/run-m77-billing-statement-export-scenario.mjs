import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PartnerCommercialService } from '../src/service/partnerCommercialService.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import {
  verifyPartnerProgramCommercialUsageExportPayload,
  verifyPartnerProgramCommercialUsageExportPayloadWithPublicKeyPem,
  verifyPartnerProgramBillingStatementExportPayload,
  verifyPartnerProgramBillingStatementExportPayloadWithPublicKeyPem,
  verifyPartnerProgramSlaBreachExportPayload,
  verifyPartnerProgramSlaBreachExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M77';
const SCENARIO_FILE = 'fixtures/commercial/m77_scenario.json';
const EXPECTED_FILE = 'fixtures/commercial/m77_expected.json';
const OUTPUT_FILE = 'billing_statement_export_output.json';

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
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

function endpointFor(operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint for operation_id=${operationId}`);
  return ep;
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
    const field = k.slice('expect_'.length);
    assert.deepEqual(rec[field], v);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const service = new PartnerCommercialService({ store });
const policyIntegrityKeysSvc = new PolicyIntegritySigningService();

const publicKeysById = new Map();
const usageExportRefs = {};
const billingExportRefs = {};
const slaExportRefs = {};
const oauthClientRefs = {};
const oauthTokenRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'keys.policy_integrity_signing.get') {
    const response = policyIntegrityKeysSvc.getSigningKeys();
    validateApiResponse(op.op, response);

    for (const key of response.body?.keys ?? []) {
      if (key?.key_id && key?.public_key_pem) {
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

  if (op.op === 'partnerProgram.commercial_usage.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});
    const response = service.recordCommercialUsage({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      entry_id: response.ok ? (response.body.entry?.entry_id ?? null) : null,
      partner_id: response.ok ? (response.body.entry?.partner_id ?? null) : null,
      feature_code: response.ok ? (response.body.entry?.feature_code ?? null) : null,
      unit_type: response.ok ? (response.body.entry?.unit_type ?? null) : null,
      units: response.ok ? (response.body.entry?.units ?? null) : null,
      amount_usd_micros: response.ok ? (response.body.entry?.amount_usd_micros ?? null) : null,
      ledger_entries_count: response.ok ? (response.body.ledger_summary?.entries_count ?? null) : null,
      ledger_total_units: response.ok ? (response.body.ledger_summary?.total_units ?? null) : null,
      ledger_total_amount_usd_micros: response.ok ? (response.body.ledger_summary?.total_amount_usd_micros ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.commercial_usage.export') {
    const query = clone(op.query ?? {});
    const response = service.exportCommercialUsage({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) usageExportRefs[op.save_export_ref] = response.body;

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      entries_count: response.ok ? (response.body.entries?.length ?? 0) : null,
      total_units: response.ok ? (response.body.ledger_summary?.total_units ?? null) : null,
      total_amount_usd_micros: response.ok ? (response.body.ledger_summary?.total_amount_usd_micros ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.commercial_usage.export.verify') {
    const payload = usageExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const verified = verifyPartnerProgramCommercialUsageExportPayload(payload);
    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramCommercialUsageExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg: payload.signature?.alg })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.commercial_usage.export.verify_tampered') {
    const payload = usageExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);
    const tampered = clone(payload);
    const h = String(tampered.export_hash ?? '');
    tampered.export_hash = `${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}`;

    const verified = verifyPartnerProgramCommercialUsageExportPayload(tampered);
    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.billing_statement.export') {
    const query = clone(op.query ?? {});
    const response = service.exportBillingStatement({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) billingExportRefs[op.save_export_ref] = response.body;

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      lines_count: response.ok ? (response.body.statement?.lines?.length ?? 0) : null,
      gross_amount_usd_micros: response.ok ? (response.body.statement?.totals?.gross_amount_usd_micros ?? null) : null,
      partner_share_usd_micros: response.ok ? (response.body.statement?.totals?.partner_share_usd_micros ?? null) : null,
      platform_share_usd_micros: response.ok ? (response.body.statement?.totals?.platform_share_usd_micros ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.billing_statement.export.verify') {
    const payload = billingExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const verified = verifyPartnerProgramBillingStatementExportPayload(payload);
    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramBillingStatementExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg: payload.signature?.alg })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.billing_statement.export.verify_tampered') {
    const payload = billingExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);
    const tampered = clone(payload);
    const h = String(tampered.export_hash ?? '');
    tampered.export_hash = `${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}`;

    const verified = verifyPartnerProgramBillingStatementExportPayload(tampered);
    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.sla_policy.upsert') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});
    const response = service.upsertSlaPolicy({ actor, auth: op.auth ?? {}, idempotencyKey: op.idempotency_key, request: op.request ?? {} });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      policy_version: response.ok ? (response.body.policy?.version ?? null) : null,
      latency_p95_ms: response.ok ? (response.body.policy?.latency_p95_ms ?? null) : null,
      availability_target_bps: response.ok ? (response.body.policy?.availability_target_bps ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.sla_breach.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});
    const response = service.recordSlaBreach({ actor, auth: op.auth ?? {}, idempotencyKey: op.idempotency_key, request: op.request ?? {} });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      event_id: response.ok ? (response.body.event?.event_id ?? null) : null,
      event_type: response.ok ? (response.body.event?.event_type ?? null) : null,
      severity: response.ok ? (response.body.event?.severity ?? null) : null,
      resolved: response.ok ? (response.body.event?.resolved === true) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.sla_breach.export') {
    const query = clone(op.query ?? {});
    const response = service.exportSlaBreachEvents({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) slaExportRefs[op.save_export_ref] = response.body;

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      total_events: response.ok ? (response.body.summary?.total_events ?? null) : null,
      open_events: response.ok ? (response.body.summary?.open_events ?? null) : null,
      high_severity_events: response.ok ? (response.body.summary?.high_severity_events ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.sla_breach.export.verify') {
    const payload = slaExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const verified = verifyPartnerProgramSlaBreachExportPayload(payload);
    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramSlaBreachExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg: payload.signature?.alg })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.sla_breach.export.verify_tampered') {
    const payload = slaExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);
    const tampered = clone(payload);
    const h = String(tampered.export_hash ?? '');
    tampered.export_hash = `${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}`;

    const verified = verifyPartnerProgramSlaBreachExportPayload(tampered);
    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.dashboard.summary.get') {
    const query = clone(op.query ?? {});
    const response = service.getDashboardSummary({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      usage_entries_count: response.ok ? (response.body.usage_last_24h?.entries_count ?? null) : null,
      usage_total_units: response.ok ? (response.body.usage_last_24h?.total_units ?? null) : null,
      usage_total_amount_usd_micros: response.ok ? (response.body.usage_last_24h?.total_amount_usd_micros ?? null) : null,
      open_breaches: response.ok ? (response.body.sla?.open_breaches ?? null) : null,
      high_severity_open_breaches: response.ok ? (response.body.sla?.high_severity_open_breaches ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'auth.oauth_client.register') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});
    const response = service.registerOauthClient({ actor, auth: op.auth ?? {}, idempotencyKey: op.idempotency_key, request: op.request ?? {} });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_client_ref) oauthClientRefs[op.save_client_ref] = response.body.client?.client_id ?? null;
    if (response.ok && op.save_token_ref) oauthTokenRefs[op.save_token_ref] = response.body.issued_test_token ?? null;

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      client_id: response.ok ? (response.body.client?.client_id ?? null) : null,
      secret_version: response.ok ? (response.body.client?.secret_version ?? null) : null,
      client_status: response.ok ? (response.body.client?.status ?? null) : null,
      issued_test_token: response.ok ? (response.body.issued_test_token ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'auth.oauth_client.rotate') {
    const request = clone(op.request ?? {});
    if (op.client_id_ref) {
      const clientId = oauthClientRefs[op.client_id_ref];
      if (!clientId) throw new Error(`missing client_id_ref: ${op.client_id_ref}`);
      request.client_id = clientId;
    }

    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const response = service.rotateOauthClientSecret({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      clientId: op.client_id_ref ? oauthClientRefs[op.client_id_ref] : request.client_id,
      request
    });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_token_ref) oauthTokenRefs[op.save_token_ref] = response.body.issued_test_token ?? null;

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      client_id: response.ok ? (response.body.client?.client_id ?? null) : null,
      secret_version: response.ok ? (response.body.client?.secret_version ?? null) : null,
      client_status: response.ok ? (response.body.client?.status ?? null) : null,
      issued_test_token: response.ok ? (response.body.issued_test_token ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'auth.oauth_client.revoke') {
    const request = clone(op.request ?? {});
    if (op.client_id_ref) {
      const clientId = oauthClientRefs[op.client_id_ref];
      if (!clientId) throw new Error(`missing client_id_ref: ${op.client_id_ref}`);
      request.client_id = clientId;
    }

    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const response = service.revokeOauthClient({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      clientId: op.client_id_ref ? oauthClientRefs[op.client_id_ref] : request.client_id,
      request
    });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      client_id: response.ok ? (response.body.client?.client_id ?? null) : null,
      client_status: response.ok ? (response.body.client?.status ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'auth.oauth_token.introspect') {
    const request = clone(op.request ?? {});
    if (op.token_ref) {
      const token = oauthTokenRefs[op.token_ref];
      if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);
      request.token = token;
    }

    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const response = service.introspectOauthToken({ actor, auth: op.auth ?? {}, request });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      active: response.ok ? (response.body.active === true) : null,
      client_id: response.ok ? (response.body.client_id ?? null) : null,
      reason_code: response.ok ? (response.body.reason_code ?? null) : null,
      scopes_count: response.ok ? (response.body.scopes?.length ?? 0) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  usage_ledger: clone(store.state.partner_program_commercial_usage_ledger ?? []),
  sla_policy: clone(store.state.partner_program_sla_policy ?? {}),
  sla_breach_events: clone(store.state.partner_program_sla_breach_events ?? []),
  oauth_clients: clone(store.state.oauth_clients ?? {}),
  oauth_tokens: clone(store.state.oauth_tokens ?? {})
};

const out = canonicalize({ operations, final });

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = createHash('sha256').update(JSON.stringify(out), 'utf8').digest('hex');
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
