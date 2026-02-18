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
export function authorizeApiOperation({ operationId, actor, auth, store }) {
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

  const delegation = auth?.delegation ?? null;
  let persistedDelegation = null;
  let effectiveDelegation = delegation;

  // Agent actor type implies delegation in v1.
  if (actor.type === 'agent') {
    if (!delegation) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'agent access requires delegation',
          details: { operation_id: operationId, actor }
        }
      };
    }

    const delegationId = delegation?.delegation_id ?? null;
    if (!delegationId) {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'delegation_id is required',
          details: { operation_id: operationId, actor }
        }
      };
    }

    persistedDelegation = store?.state?.delegations?.[delegationId] ?? null;
    if (persistedDelegation) effectiveDelegation = persistedDelegation;

    const principal = effectiveDelegation?.principal_agent ?? null;
    if (principal?.type !== 'agent' || principal?.id !== actor.id) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'delegation principal mismatch',
          details: { operation_id: operationId, actor, principal_agent: principal }
        }
      };
    }

    const subject = effectiveDelegation?.subject_actor ?? null;
    if (subject?.type !== 'user' || !subject?.id) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'delegation subject must be a user',
          details: { operation_id: operationId, actor, subject_actor: subject }
        }
      };
    }

    // If the delegation is persisted in store, require the presented grant to match.
    if (persistedDelegation) {
      const presentedSubject = delegation?.subject_actor ?? null;
      const presentedPrincipal = delegation?.principal_agent ?? null;

      if (presentedSubject?.type !== subject.type || presentedSubject?.id !== subject.id) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'delegation subject mismatch',
            details: { operation_id: operationId, actor, subject_actor: subject, presented_subject_actor: presentedSubject }
          }
        };
      }

      if (presentedPrincipal?.type !== principal.type || presentedPrincipal?.id !== principal.id) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'delegation principal mismatch',
            details: { operation_id: operationId, actor, principal_agent: principal, presented_principal_agent: presentedPrincipal }
          }
        };
      }
    }

    // Lifecycle: revoked grants are rejected (persisted revocations win).
    const revokedAt = persistedDelegation?.revoked_at ?? delegation?.revoked_at ?? null;
    if (revokedAt) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'delegation revoked',
          details: { operation_id: operationId, delegation_id: delegationId, revoked_at: revokedAt }
        }
      };
    }

    // Lifecycle: expiry is evaluated deterministically when a `now` is provided.
    const nowIso = auth?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? null;
    const expiresAt = persistedDelegation?.expires_at ?? delegation?.expires_at ?? null;
    if (nowIso && expiresAt) {
      const nowMs = Date.parse(nowIso);
      const expMs = Date.parse(expiresAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(expMs)) {
        return {
          ok: false,
          error: {
            code: 'CONSTRAINT_VIOLATION',
            message: 'invalid ISO timestamp for delegation lifecycle check',
            details: { operation_id: operationId, now_iso: nowIso, expires_at: expiresAt }
          }
        };
      }

      if (nowMs > expMs) {
        return {
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'delegation expired',
            details: { operation_id: operationId, delegation_id: delegationId, now_iso: nowIso, expires_at: expiresAt }
          }
        };
      }
    }
  }

  const requiredScopes = sortedUniqueStrings(opAuth.required_scopes ?? []);
  const providedScopes = actor.type === 'agent'
    ? sortedUniqueStrings(effectiveDelegation?.scopes ?? delegation?.scopes ?? [])
    : sortedUniqueStrings(auth?.scopes ?? []);

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
