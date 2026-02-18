import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let _opAuth;

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/core -> repo root
  return path.resolve(here, '../..');
}

function loadOpAuthMap() {
  if (_opAuth) return _opAuth;

  const root = repoRoot();
  const manifestPath = path.join(root, 'docs/spec/api/manifest.v1.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const map = new Map();
  for (const ep of manifest.endpoints ?? []) {
    if (!ep?.operation_id) continue;
    map.set(ep.operation_id, ep.auth ?? null);
  }

  _opAuth = map;
  return _opAuth;
}

export function authzEnforced() {
  return process.env.AUTHZ_ENFORCE === '1';
}

function sortedUniqueStrings(xs) {
  const out = Array.from(new Set((xs ?? []).filter(Boolean)));
  out.sort();
  return out;
}

/**
 * Enforce endpoint auth requirements using the API manifest as source of truth.
 *
 * @param {{ operationId: string, actor: any, auth?: { scopes?: string[] } }} params
 * @returns {{ ok: true, skipped?: boolean } | { ok: false, error: { code: string, message: string, details: any } }}
 */
export function authorizeApiOperation({ operationId, actor, auth }) {
  if (!authzEnforced()) return { ok: true, skipped: true };

  if (!operationId) {
    return {
      ok: false,
      error: {
        code: 'CONSTRAINT_VIOLATION',
        message: 'operationId is required',
        details: { operation_id: null }
      }
    };
  }

  const opAuth = loadOpAuthMap().get(operationId);

  // If the manifest is missing auth info, treat it as forbidden in strict mode.
  if (!opAuth) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'operation auth is not declared',
        details: { operation_id: operationId }
      }
    };
  }

  if (opAuth.required === false) {
    return { ok: true };
  }

  if (!actor) {
    return {
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'authentication required',
        details: { operation_id: operationId }
      }
    };
  }

  const allowedTypes = sortedUniqueStrings(opAuth.allowed_actor_types ?? []);
  if (allowedTypes.length > 0) {
    if (!allowedTypes.includes(actor.type)) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'actor type is not allowed',
          details: {
            operation_id: operationId,
            actor_type: actor?.type ?? null,
            allowed_actor_types: allowedTypes
          }
        }
      };
    }
  }

  const requiredScopes = sortedUniqueStrings(opAuth.required_scopes ?? []);
  const providedScopes = sortedUniqueStrings(auth?.scopes ?? []);

  // If the endpoint requires auth and declares scopes, enforce them.
  if (requiredScopes.length > 0) {
    const missing = requiredScopes.filter(s => !providedScopes.includes(s));
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          code: 'INSUFFICIENT_SCOPE',
          message: 'insufficient scope',
          details: {
            operation_id: operationId,
            required_scopes: requiredScopes,
            provided_scopes: providedScopes,
            missing_scopes: missing
          }
        }
      };
    }
  }

  return { ok: true };
}
