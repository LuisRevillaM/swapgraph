import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apiDir = path.join(root, 'docs/spec/api');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const allowedActorTypes = new Set(['user', 'partner', 'agent']);

const allowedScopes = new Set([
  'swap_intents:read',
  'swap_intents:write',
  'cycle_proposals:read',
  'commits:read',
  'commits:write',
  'settlement:read',
  'settlement:write',
  'receipts:read',
  'keys:read',
  'delegations:read',
  'delegations:write'
]);

function isObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

const apiManifestPath = path.join(apiDir, 'manifest.v1.json');
const apiManifest = readJson(apiManifestPath);

const errors = [];

for (const ep of apiManifest.endpoints ?? []) {
  const key = `${ep.method ?? '?'} ${ep.path ?? '?'}`;

  if (!ep.operation_id) {
    errors.push({ code: 'ENDPOINT_OPERATION_ID', msg: 'missing operation_id', key });
    continue;
  }

  if (!isObject(ep.auth)) {
    errors.push({ code: 'ENDPOINT_AUTH_MISSING', msg: 'endpoint missing auth object', key, operation_id: ep.operation_id });
    continue;
  }

  const auth = ep.auth;
  if (typeof auth.required !== 'boolean') {
    errors.push({ code: 'AUTH_REQUIRED', msg: 'auth.required must be boolean', key, operation_id: ep.operation_id });
  }

  if (!Array.isArray(auth.allowed_actor_types) || auth.allowed_actor_types.length === 0) {
    errors.push({ code: 'AUTH_ACTOR_TYPES', msg: 'auth.allowed_actor_types must be a non-empty array', key, operation_id: ep.operation_id });
  } else {
    for (const t of auth.allowed_actor_types) {
      if (!allowedActorTypes.has(t)) {
        errors.push({ code: 'AUTH_ACTOR_TYPE_INVALID', msg: 'invalid actor type in auth.allowed_actor_types', key, operation_id: ep.operation_id, actor_type: t });
      }
    }
  }

  if (!Array.isArray(auth.required_scopes)) {
    errors.push({ code: 'AUTH_SCOPES', msg: 'auth.required_scopes must be an array', key, operation_id: ep.operation_id });
  } else {
    for (const s of auth.required_scopes) {
      if (!allowedScopes.has(s)) {
        errors.push({ code: 'AUTH_SCOPE_INVALID', msg: 'unknown scope in auth.required_scopes', key, operation_id: ep.operation_id, scope: s });
      }
    }
  }

  // Convention checks
  const isKeysEndpoint = typeof ep.path === 'string' && ep.path.startsWith('/keys/');
  if (isKeysEndpoint && auth.required !== false) {
    errors.push({ code: 'AUTH_KEYS_PUBLIC', msg: 'keys endpoints must be public (auth.required=false) in v1', key, operation_id: ep.operation_id });
  }

  const isWrite = !!ep.idempotency_required;
  if (auth.required === true && isWrite) {
    const hasWriteScope = (auth.required_scopes ?? []).some(s => s.endsWith(':write'));
    if (!hasWriteScope) {
      errors.push({ code: 'AUTH_WRITE_SCOPE', msg: 'idempotent write endpoints should require at least one :write scope', key, operation_id: ep.operation_id });
    }
  }
}

const overall = errors.length === 0;
const out = { overall, manifest: apiManifest.id, errors, scopes: [...allowedScopes].sort() };

if (!overall) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(out, null, 2));
