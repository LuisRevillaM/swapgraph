import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { DelegationTokenAuthService } from '../src/service/delegationTokenAuthService.mjs';
import { decodeDelegationTokenString, encodeDelegationTokenString } from '../src/crypto/delegationTokenSigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M36 scenario');
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function tamperToken(token) {
  const decoded = decodeDelegationTokenString(token);
  if (!decoded.ok) throw new Error(`cannot tamper undecodable token: ${decoded.error}`);

  const mutated = clone(decoded.token);
  const sig = mutated?.signature?.sig;
  if (!sig || typeof sig !== 'string') throw new Error('cannot tamper token without signature.sig');

  const first = sig[0];
  const flipped = first === 'A' ? 'B' : 'A';
  mutated.signature.sig = flipped + sig.slice(1);

  return encodeDelegationTokenString(mutated);
}

// ---- Load API manifest for schema mapping ----
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

// ---- Load schemas into AJV ----
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

// ---- Load scenario + expected ----
const scenarioPath = path.join(root, 'fixtures/delegation/m36_scenario.json');
const expectedPath = path.join(root, 'fixtures/delegation/m36_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const actors = scenario.actors;

// ---- Seed store ----
const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();
store.state.delegations ||= {};
store.save();

const delegationsSvc = new DelegationsService({ store });
const authSvc = new DelegationTokenAuthService({ store });

const operations = [];
const tokenRefs = {};

for (const op of scenario.operations ?? []) {
  if (op.op === 'auth.delegation_token.rotate') {
    process.env.DELEGATION_TOKEN_SIGNING_ACTIVE_KEY_ID = op.active_key_id;

    const rec = {
      op: op.op,
      active_key_id: process.env.DELEGATION_TOKEN_SIGNING_ACTIVE_KEY_ID
    };
    operations.push(rec);

    continue;
  }

  if (op.op === 'token.tamper_signature') {
    const base = tokenRefs[op.token_ref];
    if (!base) throw new Error(`missing token_ref: ${op.token_ref}`);

    const saveRef = op.save_token_ref;
    if (!saveRef) throw new Error('save_token_ref is required for token.tamper_signature');

    tokenRefs[saveRef] = tamperToken(base);

    operations.push({ op: op.op, token_ref: op.token_ref, save_token_ref: saveRef });
    continue;
  }

  if (op.op === 'token.unknown_key') {
    const base = tokenRefs[op.token_ref];
    if (!base) throw new Error(`missing token_ref: ${op.token_ref}`);

    const decoded = decodeDelegationTokenString(base);
    if (!decoded.ok) throw new Error(`failed to decode token_ref=${op.token_ref}: ${decoded.error}`);

    const mutated = clone(decoded.token);
    mutated.signature ||= {};
    mutated.signature.key_id = op.key_id ?? 'dev-dt-k999';

    const saveRef = op.save_token_ref;
    if (!saveRef) throw new Error('save_token_ref is required for token.unknown_key');

    tokenRefs[saveRef] = encodeDelegationTokenString(mutated);

    operations.push({ op: op.op, token_ref: op.token_ref, save_token_ref: saveRef, key_id: mutated.signature.key_id });
    continue;
  }

  if (op.op === 'keys.delegation_token_signing.get') {
    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    const res = authSvc.getSigningKeys();

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    }

    const keyStatuses = {};
    for (const k of res.body.keys ?? []) keyStatuses[k.key_id] = k.status;

    const rec = {
      op: op.op,
      ok: res.ok,
      active_key_id: res.body.active_key_id,
      keys_count: (res.body.keys ?? []).length,
      key_statuses: keyStatuses
    };
    operations.push(rec);

    continue;
  }

  if (op.op === 'delegations.create') {
    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const auth = op.auth ?? {};

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.create({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      occurredAt: op.occurred_at
    });

    const res = r.result;

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    }

    const saveRef = op.save_token_ref;
    if (res.ok && saveRef) tokenRefs[saveRef] = res.body.delegation_token;

    let tokenKeyId = null;
    if (res.ok) {
      const decoded = decodeDelegationTokenString(res.body.delegation_token);
      tokenKeyId = decoded.ok ? decoded.token?.signature?.key_id ?? null : null;
    }

    const rec = {
      op: op.op,
      actor,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      delegation_id: op.request?.delegation?.delegation_id ?? null,
      token_ref: saveRef ?? null,
      token_key_id: tokenKeyId
    };
    operations.push(rec);

    continue;
  }

  if (op.op === 'delegations.revoke') {
    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const auth = op.auth ?? {};

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.revoke({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      delegationId: op.path?.id,
      requestBody: op.request
    });

    const res = r.result;

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    }

    const rec = {
      op: op.op,
      actor,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      delegation_id: op.path?.id ?? null,
      revoked_at_present: res.ok ? !!res.body.delegation?.revoked_at : null
    };
    operations.push(rec);

    continue;
  }

  if (op.op === 'auth.delegation_token.introspect') {
    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    const token = op.token_ref ? tokenRefs[op.token_ref] : op.request?.delegation_token;

    const requestBody = {
      delegation_token: token,
      ...(op.now_iso ? { now_iso: op.now_iso } : {})
    };

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, requestBody);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const res = authSvc.introspect({
      delegationToken: requestBody.delegation_token,
      nowIso: requestBody.now_iso
    });

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    }

    const rec = {
      op: op.op,
      ok: res.ok,
      active: res.body.active,
      reason: res.body.reason,
      key_id: res.body.details?.key_id ?? null,
      delegation_id: res.body.delegation?.delegation_id ?? res.body.details?.delegation_id ?? null
    };
    operations.push(rec);

    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const out = canonicalize({ operations });
writeFileSync(path.join(outDir, 'delegation_rotation_introspection_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M36', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
