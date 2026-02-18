import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from '../util/canonicalJson.mjs';

const CONSENT_PROOF_PREFIX = 'sgcp2.';
const ALG = 'ed25519';
const DEFAULT_ACTIVE_KEY_ID = 'dev-pi-k1';

const KEY_CONFIGS = [
  {
    key_id: 'dev-pi-k1',
    private_file: 'fixtures/keys/policy_integrity_signing_dev_pi_k1_private.pem',
    public_file: 'fixtures/keys/policy_integrity_signing_dev_pi_k1_public.pem'
  },
  {
    key_id: 'dev-pi-k2',
    private_file: 'fixtures/keys/policy_integrity_signing_dev_pi_k2_private.pem',
    public_file: 'fixtures/keys/policy_integrity_signing_dev_pi_k2_public.pem'
  }
];

let _keyMaterialById;

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/crypto -> repo root
  return path.resolve(here, '../..');
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function keyConfigById(keyId) {
  return KEY_CONFIGS.find(k => k.key_id === keyId) ?? null;
}

function resolveActiveKeyId() {
  const configured = process.env.POLICY_INTEGRITY_SIGNING_ACTIVE_KEY_ID?.trim();
  if (configured && keyConfigById(configured)) return configured;
  return DEFAULT_ACTIVE_KEY_ID;
}

function getKeyMaterialMap() {
  if (_keyMaterialById) return _keyMaterialById;

  const root = repoRoot();
  const map = new Map();
  for (const cfg of KEY_CONFIGS) {
    const privPem = readFileSync(path.join(root, cfg.private_file), 'utf8');
    const pubPem = readFileSync(path.join(root, cfg.public_file), 'utf8');

    map.set(cfg.key_id, {
      key_id: cfg.key_id,
      privateKey: crypto.createPrivateKey(privPem),
      publicKey: crypto.createPublicKey(pubPem),
      public_key_pem: pubPem
    });
  }

  _keyMaterialById = map;
  return _keyMaterialById;
}

function signingMessage(value) {
  const unsigned = clone(value);
  delete unsigned.signature;
  return Buffer.from(canonicalStringify(unsigned), 'utf8');
}

function parseIso(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function sha256HexCanonical(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function normalizeExportQuery(query) {
  const out = {};

  if (typeof query?.subject_actor_id === 'string' && query.subject_actor_id.trim()) out.subject_actor_id = query.subject_actor_id.trim();
  if (typeof query?.decision === 'string' && query.decision.trim()) out.decision = query.decision.trim();
  if (typeof query?.operation_id === 'string' && query.operation_id.trim()) out.operation_id = query.operation_id.trim();
  if (typeof query?.delegation_id === 'string' && query.delegation_id.trim()) out.delegation_id = query.delegation_id.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();

  return out;
}

function exportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeExportQuery(payload?.query),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    entries: payload?.entries ?? [],
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function policyIntegritySigningMessageBytes(value) {
  return signingMessage(value);
}

export function getPolicyIntegritySigningActiveKeyId() {
  return resolveActiveKeyId();
}

export function getPolicyIntegritySigningPublicKeys() {
  const activeKeyId = resolveActiveKeyId();
  const mat = getKeyMaterialMap();

  return KEY_CONFIGS.map(cfg => {
    const key = mat.get(cfg.key_id);
    return {
      key_id: cfg.key_id,
      alg: ALG,
      public_key_pem: key.public_key_pem,
      status: cfg.key_id === activeKeyId ? 'active' : 'verify_only'
    };
  });
}

export function signPolicyIntegrityPayload(payload, { keyId } = {}) {
  const selectedKeyId = keyId ?? resolveActiveKeyId();
  const key = getKeyMaterialMap().get(selectedKeyId);
  if (!key) throw new Error(`unknown policy integrity signing key id: ${selectedKeyId}`);

  const sig = crypto.sign(null, signingMessage(payload), key.privateKey);

  return {
    key_id: selectedKeyId,
    alg: ALG,
    sig: sig.toString('base64')
  };
}

export function verifyPolicyIntegrityPayloadSignature(payload) {
  const sigB64 = payload?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  const keyId = payload?.signature?.key_id;
  const key = getKeyMaterialMap().get(keyId);
  if (!key) return { ok: false, error: 'unknown_key_id', details: { key_id: keyId ?? null } };

  if (payload?.signature?.alg !== ALG) {
    return { ok: false, error: 'unsupported_alg', details: { alg: payload?.signature?.alg ?? null } };
  }

  let sig;
  try {
    sig = Buffer.from(sigB64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_base64' };
  }

  const ok = crypto.verify(null, signingMessage(payload), key.publicKey, sig);
  return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
}

export function verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!publicKeyPem) return { ok: false, error: 'missing_public_key' };

  const sigB64 = payload?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  if (keyId && payload?.signature?.key_id !== keyId) {
    return { ok: false, error: 'unknown_key_id', details: { key_id: payload?.signature?.key_id ?? null } };
  }

  if (alg && payload?.signature?.alg !== alg) {
    return { ok: false, error: 'unsupported_alg', details: { alg: payload?.signature?.alg ?? null } };
  }

  if (payload?.signature?.alg !== ALG) {
    return { ok: false, error: 'unsupported_alg', details: { alg: payload?.signature?.alg ?? null } };
  }

  let sig;
  try {
    sig = Buffer.from(sigB64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_base64' };
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch (e) {
    return { ok: false, error: 'invalid_public_key', details: { message: String(e?.message ?? e) } };
  }

  const ok = crypto.verify(null, signingMessage(payload), publicKey, sig);
  return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
}

export function encodeSignedConsentProofString(proof) {
  const json = canonicalStringify(proof);
  const b64u = Buffer.from(json, 'utf8').toString('base64url');
  return `${CONSENT_PROOF_PREFIX}${b64u}`;
}

export function decodeSignedConsentProofString(tokenString) {
  if (!tokenString || typeof tokenString !== 'string') {
    return { ok: false, error: 'missing_token' };
  }

  if (!tokenString.startsWith(CONSENT_PROOF_PREFIX)) {
    return {
      ok: false,
      error: 'unsupported_token_prefix',
      details: { expected_prefix: CONSENT_PROOF_PREFIX }
    };
  }

  const b64u = tokenString.slice(CONSENT_PROOF_PREFIX.length);

  let json;
  try {
    json = Buffer.from(b64u, 'base64url').toString('utf8');
  } catch {
    return { ok: false, error: 'invalid_base64url' };
  }

  let proof;
  try {
    proof = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  return { ok: true, proof };
}

export function mintSignedConsentProof({ binding, issuedAt, expiresAt, nonce, keyId }) {
  const proof = {
    binding: String(binding ?? '')
  };

  if (issuedAt) proof.issued_at = issuedAt;
  if (expiresAt) proof.expires_at = expiresAt;
  if (nonce) proof.nonce = nonce;

  proof.signature = signPolicyIntegrityPayload(proof, { keyId });

  return encodeSignedConsentProofString(proof);
}

export function verifySignedConsentProofString({ tokenString, expectedBinding, nowIso }) {
  const decoded = decodeSignedConsentProofString(tokenString);
  if (!decoded.ok) return decoded;

  const proof = decoded.proof;
  const binding = proof?.binding;
  if (typeof binding !== 'string' || binding.trim().length < 1) {
    return { ok: false, error: 'missing_binding' };
  }

  const verified = verifyPolicyIntegrityPayloadSignature(proof);
  if (!verified.ok) return verified;

  if (typeof expectedBinding === 'string' && expectedBinding.length > 0 && binding.trim() !== expectedBinding) {
    return {
      ok: false,
      error: 'binding_mismatch',
      details: {
        expected_binding: expectedBinding,
        provided_binding: binding.trim()
      }
    };
  }

  if (proof.expires_at) {
    const effectiveNowIso = nowIso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    const nowMs = parseIso(effectiveNowIso);
    const expMs = parseIso(proof.expires_at);
    if (nowMs === null || expMs === null) {
      return {
        ok: false,
        error: 'invalid_timestamps',
        details: {
          now_iso: effectiveNowIso,
          expires_at: proof.expires_at
        }
      };
    }

    if (nowMs > expMs) {
      return {
        ok: false,
        error: 'expired',
        details: {
          now_iso: effectiveNowIso,
          expires_at: proof.expires_at
        }
      };
    }

    if (proof.issued_at) {
      const issuedMs = parseIso(proof.issued_at);
      if (issuedMs === null) {
        return {
          ok: false,
          error: 'invalid_timestamps',
          details: {
            now_iso: effectiveNowIso,
            issued_at: proof.issued_at,
            expires_at: proof.expires_at
          }
        };
      }

      if (issuedMs > expMs) {
        return {
          ok: false,
          error: 'invalid_timestamps',
          details: {
            issued_at: proof.issued_at,
            expires_at: proof.expires_at
          }
        };
      }
    }
  }

  return { ok: true, proof };
}

export function buildPolicyAuditExportHash({ entries, totalFiltered, query }) {
  const input = {
    entries: entries ?? [],
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    query: normalizeExportQuery(query)
  };

  return sha256HexCanonical(input);
}

export function buildSignedPolicyAuditExportPayload({ exportedAt, query, entries, totalFiltered, keyId }) {
  const normalizedQuery = normalizeExportQuery(query);
  const exportHash = buildPolicyAuditExportHash({ entries, totalFiltered, query: normalizedQuery });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    entries: entries ?? [],
    export_hash: exportHash
  };

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPolicyAuditExportPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildPolicyAuditExportHash({
    entries: payload.entries,
    totalFiltered: payload.total_filtered,
    query: payload.query
  });

  if (payload.export_hash !== expectedHash) {
    return {
      ok: false,
      error: 'hash_mismatch',
      details: {
        expected_hash: expectedHash,
        provided_hash: payload.export_hash ?? null
      }
    };
  }

  const signable = exportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPolicyAuditExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildPolicyAuditExportHash({
    entries: payload.entries,
    totalFiltered: payload.total_filtered,
    query: payload.query
  });

  if (payload.export_hash !== expectedHash) {
    return {
      ok: false,
      error: 'hash_mismatch',
      details: {
        expected_hash: expectedHash,
        provided_hash: payload.export_hash ?? null
      }
    };
  }

  const signable = exportSignablePayload(payload);

  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
    payload: signable,
    publicKeyPem,
    keyId,
    alg
  });
}
