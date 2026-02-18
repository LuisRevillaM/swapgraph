import { verifyDelegationTokenString } from '../crypto/delegationTokenSigning.mjs';

function normalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[String(k).toLowerCase()] = v;
  }
  return out;
}

function error(code, message, details = {}) {
  return { code, message, details };
}

/**
 * Parse headers into fixtures-first auth context.
 *
 * Supports delegation tokens:
 *   Authorization: Bearer sgdt1.<base64url-token>
 *
 * @param {{ headers?: Record<string, string|undefined|null> }} params
 * @returns {{ ok: true, actor: any, auth: any } | { ok: false, error: { code: string, message: string, details: any } }}
 */
export function parseAuthHeaders({ headers }) {
  const h = normalizeHeaders(headers);

  const authz = h['authorization'];
  if (!authz) {
    return { ok: false, error: error('UNAUTHORIZED', 'missing Authorization header', {}) };
  }

  const m = /^Bearer\s+(.+)$/i.exec(String(authz).trim());
  if (!m) {
    return { ok: false, error: error('UNAUTHORIZED', 'unsupported authorization scheme', { authorization: authz }) };
  }

  const tokenString = m[1].trim();
  const v = verifyDelegationTokenString(tokenString);
  if (!v.ok) {
    return { ok: false, error: error('UNAUTHORIZED', 'invalid delegation token', { reason: v.error, details: v.details ?? null }) };
  }

  const delegation = v.token?.delegation;
  const actor = delegation?.principal_agent;
  if (!actor?.type || !actor?.id) {
    return { ok: false, error: error('UNAUTHORIZED', 'delegation token missing principal agent', {}) };
  }

  const auth = { delegation };
  const nowIso = h['x-now-iso'];
  if (typeof nowIso === 'string' && nowIso.trim().length > 0) {
    auth.now_iso = nowIso.trim();
  }

  return { ok: true, actor, auth };
}
