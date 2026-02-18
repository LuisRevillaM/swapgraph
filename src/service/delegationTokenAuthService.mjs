import {
  decodeDelegationTokenString,
  verifyDelegationTokenSignature,
  getDelegationTokenSigningPublicKeys,
  getDelegationTokenSigningActiveKeyId
} from '../crypto/delegationTokenSigning.mjs';

function correlationIdForKeys() {
  return 'corr_keys_delegation_token_signing';
}

function correlationIdForIntrospection() {
  return 'corr_delegation_token_introspect';
}

function actorKey(actor) {
  if (!actor?.type || !actor?.id) return null;
  return `${actor.type}:${actor.id}`;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mapDecodeErrorReason(err) {
  switch (err) {
    case 'missing_token':
      return 'missing_token';
    case 'unsupported_token_prefix':
      return 'unsupported_token_prefix';
    case 'invalid_base64url':
    case 'invalid_json':
      return 'malformed';
    default:
      return 'malformed';
  }
}

function mapVerifyErrorReason(err) {
  switch (err) {
    case 'unknown_key_id':
      return 'unknown_key_id';
    case 'unsupported_alg':
      return 'unsupported_alg';
    case 'missing_signature':
    case 'invalid_base64':
    case 'bad_signature':
      return 'invalid_signature';
    default:
      return 'invalid_signature';
  }
}

function parseIso(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export class DelegationTokenAuthService {
  constructor({ store }) {
    this.store = store;
  }

  getSigningKeys() {
    return {
      ok: true,
      body: {
        correlation_id: correlationIdForKeys(),
        active_key_id: getDelegationTokenSigningActiveKeyId(),
        keys: getDelegationTokenSigningPublicKeys()
      }
    };
  }

  introspect({ delegationToken, nowIso }) {
    const correlation_id = correlationIdForIntrospection();

    const details = {};
    if (nowIso) details.now_iso = nowIso;

    if (!delegationToken) {
      return {
        ok: true,
        body: {
          correlation_id,
          active: false,
          reason: 'missing_token',
          details
        }
      };
    }

    const decoded = decodeDelegationTokenString(delegationToken);
    if (!decoded.ok) {
      return {
        ok: true,
        body: {
          correlation_id,
          active: false,
          reason: mapDecodeErrorReason(decoded.error),
          details: {
            ...details,
            decode_error: decoded.error,
            decode_details: decoded.details ?? null
          }
        }
      };
    }

    const token = decoded.token;
    const signature = token?.signature ?? {};
    if (signature.key_id) details.key_id = signature.key_id;
    if (signature.alg) details.alg = signature.alg;

    const verified = verifyDelegationTokenSignature(token);
    if (!verified.ok) {
      return {
        ok: true,
        body: {
          correlation_id,
          active: false,
          reason: mapVerifyErrorReason(verified.error),
          delegation: token?.delegation,
          details: {
            ...details,
            verify_error: verified.error,
            verify_details: verified.details ?? null
          }
        }
      };
    }

    const presentedDelegation = token?.delegation;
    if (!presentedDelegation || typeof presentedDelegation !== 'object') {
      return {
        ok: true,
        body: {
          correlation_id,
          active: false,
          reason: 'malformed',
          details: {
            ...details,
            verify_error: 'missing_delegation'
          }
        }
      };
    }

    const delegationId = presentedDelegation?.delegation_id;
    if (!delegationId) {
      return {
        ok: true,
        body: {
          correlation_id,
          active: false,
          reason: 'malformed',
          details: {
            ...details,
            verify_error: 'missing_delegation_id'
          }
        }
      };
    }

    const persistedDelegation = this.store?.state?.delegations?.[delegationId] ?? null;
    const effectiveDelegation = persistedDelegation ? clone(persistedDelegation) : clone(presentedDelegation);

    details.delegation_id = delegationId;
    details.from_store = !!persistedDelegation;

    if (persistedDelegation) {
      const principalMismatch = actorKey(presentedDelegation.principal_agent) !== actorKey(effectiveDelegation.principal_agent);
      const subjectMismatch = actorKey(presentedDelegation.subject_actor) !== actorKey(effectiveDelegation.subject_actor);
      if (principalMismatch || subjectMismatch) {
        return {
          ok: true,
          body: {
            correlation_id,
            active: false,
            reason: 'delegation_mismatch',
            delegation: effectiveDelegation,
            details: {
              ...details,
              principal_mismatch: principalMismatch,
              subject_mismatch: subjectMismatch
            }
          }
        };
      }
    }

    const revokedAt = effectiveDelegation?.revoked_at ?? null;
    if (revokedAt) {
      return {
        ok: true,
        body: {
          correlation_id,
          active: false,
          reason: 'revoked',
          delegation: effectiveDelegation,
          details: {
            ...details,
            revoked_at: revokedAt
          }
        }
      };
    }

    const effectiveNowIso = nowIso ?? process.env.AUTHZ_NOW_ISO ?? null;
    if (effectiveNowIso && effectiveDelegation?.expires_at) {
      const nowMs = parseIso(effectiveNowIso);
      const expMs = parseIso(effectiveDelegation.expires_at);

      if (nowMs === null || expMs === null) {
        return {
          ok: true,
          body: {
            correlation_id,
            active: false,
            reason: 'malformed',
            delegation: effectiveDelegation,
            details: {
              ...details,
              verify_error: 'invalid_iso_datetime'
            }
          }
        };
      }

      if (nowMs > expMs) {
        return {
          ok: true,
          body: {
            correlation_id,
            active: false,
            reason: 'expired',
            delegation: effectiveDelegation,
            details: {
              ...details,
              expires_at: effectiveDelegation.expires_at
            }
          }
        };
      }
    }

    return {
      ok: true,
      body: {
        correlation_id,
        active: true,
        reason: 'active',
        delegation: effectiveDelegation,
        details
      }
    };
  }
}
