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

  const limit = Number.parseInt(String(query?.limit ?? ''), 10);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();

  return out;
}

function normalizeExportAttestation(attestation) {
  if (!attestation || typeof attestation !== 'object') return null;
  return {
    cursor_after: typeof attestation.cursor_after === 'string' && attestation.cursor_after.trim() ? attestation.cursor_after.trim() : null,
    next_cursor: typeof attestation.next_cursor === 'string' && attestation.next_cursor.trim() ? attestation.next_cursor.trim() : null,
    attestation_after: typeof attestation.attestation_after === 'string' && attestation.attestation_after.trim() ? attestation.attestation_after.trim() : null,
    page_hash: typeof attestation.page_hash === 'string' ? attestation.page_hash : null,
    chain_hash: typeof attestation.chain_hash === 'string' ? attestation.chain_hash : null
  };
}

function normalizeExportCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  return {
    checkpoint_after: typeof checkpoint.checkpoint_after === 'string' && checkpoint.checkpoint_after.trim() ? checkpoint.checkpoint_after.trim() : null,
    attestation_chain_hash: typeof checkpoint.attestation_chain_hash === 'string' ? checkpoint.attestation_chain_hash : null,
    next_cursor: typeof checkpoint.next_cursor === 'string' && checkpoint.next_cursor.trim() ? checkpoint.next_cursor.trim() : null,
    entries_count: Number.isFinite(checkpoint.entries_count) ? Number(checkpoint.entries_count) : 0,
    total_filtered: Number.isFinite(checkpoint.total_filtered) ? Number(checkpoint.total_filtered) : 0,
    checkpoint_hash: typeof checkpoint.checkpoint_hash === 'string' ? checkpoint.checkpoint_hash : null
  };
}

function exportSignablePayload(payload) {
  const out = {
    exported_at: payload?.exported_at,
    query: normalizeExportQuery(payload?.query),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    entries: payload?.entries ?? [],
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };

  if (typeof payload?.next_cursor === 'string' && payload.next_cursor.trim()) out.next_cursor = payload.next_cursor.trim();

  const attestation = normalizeExportAttestation(payload?.attestation);
  if (attestation) out.attestation = attestation;

  const checkpoint = normalizeExportCheckpoint(payload?.checkpoint);
  if (checkpoint) out.checkpoint = checkpoint;

  return out;
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

export function mintSignedConsentProof({ binding, issuedAt, expiresAt, nonce, challengeId, challengeBinding, keyId }) {
  const proof = {
    binding: String(binding ?? '')
  };

  if (issuedAt) proof.issued_at = issuedAt;
  if (expiresAt) proof.expires_at = expiresAt;
  if (nonce) proof.nonce = nonce;
  if (challengeId) proof.challenge_id = challengeId;
  if (challengeBinding) proof.challenge_binding = challengeBinding;

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

export function buildPolicyAuditExportHash({ entries, totalFiltered, query, nextCursor }) {
  const input = {
    entries: entries ?? [],
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    query: normalizeExportQuery(query)
  };

  if (typeof nextCursor === 'string' && nextCursor.trim()) input.next_cursor = nextCursor.trim();

  return sha256HexCanonical(input);
}

export function buildPolicyAuditExportAttestation({ query, nextCursor, exportHash }) {
  const normalizedQuery = normalizeExportQuery(query);
  const cursorAfter = typeof normalizedQuery.cursor_after === 'string' ? normalizedQuery.cursor_after : null;
  const attestationAfter = typeof normalizedQuery.attestation_after === 'string' ? normalizedQuery.attestation_after : null;
  const next = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;

  const attestationInput = {
    cursor_after: cursorAfter,
    next_cursor: next,
    attestation_after: attestationAfter,
    page_hash: exportHash
  };

  return {
    ...attestationInput,
    chain_hash: sha256HexCanonical(attestationInput)
  };
}

export function verifyPolicyAuditExportAttestation({ attestation, query, nextCursor, exportHash }) {
  const provided = normalizeExportAttestation(attestation);
  if (!provided) return { ok: false, error: 'attestation_missing' };

  const expected = buildPolicyAuditExportAttestation({ query, nextCursor, exportHash });

  if (provided.page_hash !== expected.page_hash) {
    return {
      ok: false,
      error: 'attestation_page_hash_mismatch',
      details: {
        expected_page_hash: expected.page_hash,
        provided_page_hash: provided.page_hash
      }
    };
  }

  if (provided.cursor_after !== expected.cursor_after) {
    return {
      ok: false,
      error: 'attestation_cursor_mismatch',
      details: {
        expected_cursor_after: expected.cursor_after,
        provided_cursor_after: provided.cursor_after
      }
    };
  }

  if (provided.next_cursor !== expected.next_cursor) {
    return {
      ok: false,
      error: 'attestation_next_cursor_mismatch',
      details: {
        expected_next_cursor: expected.next_cursor,
        provided_next_cursor: provided.next_cursor
      }
    };
  }

  if (provided.attestation_after !== expected.attestation_after) {
    return {
      ok: false,
      error: 'attestation_after_mismatch',
      details: {
        expected_attestation_after: expected.attestation_after,
        provided_attestation_after: provided.attestation_after
      }
    };
  }

  if (provided.chain_hash !== expected.chain_hash) {
    return {
      ok: false,
      error: 'attestation_chain_hash_mismatch',
      details: {
        expected_chain_hash: expected.chain_hash,
        provided_chain_hash: provided.chain_hash
      }
    };
  }

  return { ok: true };
}

export function buildPolicyAuditExportCheckpoint({ query, attestation, nextCursor, entriesCount, totalFiltered }) {
  const normalizedQuery = normalizeExportQuery(query);
  const checkpointAfter = typeof normalizedQuery.checkpoint_after === 'string' ? normalizedQuery.checkpoint_after : null;
  const attestationChainHash = typeof attestation?.chain_hash === 'string' ? attestation.chain_hash : null;
  const next = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;

  const checkpointInput = {
    checkpoint_after: checkpointAfter,
    attestation_chain_hash: attestationChainHash,
    next_cursor: next,
    entries_count: Number.isFinite(entriesCount) ? Number(entriesCount) : 0,
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0
  };

  return {
    ...checkpointInput,
    checkpoint_hash: sha256HexCanonical(checkpointInput)
  };
}

export function verifyPolicyAuditExportCheckpoint({ checkpoint, query, attestation, nextCursor, entriesCount, totalFiltered }) {
  const provided = normalizeExportCheckpoint(checkpoint);
  if (!provided) return { ok: false, error: 'checkpoint_missing' };

  const expected = buildPolicyAuditExportCheckpoint({
    query,
    attestation,
    nextCursor,
    entriesCount,
    totalFiltered
  });

  if (provided.checkpoint_after !== expected.checkpoint_after) {
    return {
      ok: false,
      error: 'checkpoint_after_mismatch',
      details: {
        expected_checkpoint_after: expected.checkpoint_after,
        provided_checkpoint_after: provided.checkpoint_after
      }
    };
  }

  if (provided.attestation_chain_hash !== expected.attestation_chain_hash) {
    return {
      ok: false,
      error: 'checkpoint_attestation_mismatch',
      details: {
        expected_attestation_chain_hash: expected.attestation_chain_hash,
        provided_attestation_chain_hash: provided.attestation_chain_hash
      }
    };
  }

  if (provided.next_cursor !== expected.next_cursor) {
    return {
      ok: false,
      error: 'checkpoint_next_cursor_mismatch',
      details: {
        expected_next_cursor: expected.next_cursor,
        provided_next_cursor: provided.next_cursor
      }
    };
  }

  if (provided.entries_count !== expected.entries_count) {
    return {
      ok: false,
      error: 'checkpoint_entries_count_mismatch',
      details: {
        expected_entries_count: expected.entries_count,
        provided_entries_count: provided.entries_count
      }
    };
  }

  if (provided.total_filtered !== expected.total_filtered) {
    return {
      ok: false,
      error: 'checkpoint_total_filtered_mismatch',
      details: {
        expected_total_filtered: expected.total_filtered,
        provided_total_filtered: provided.total_filtered
      }
    };
  }

  if (provided.checkpoint_hash !== expected.checkpoint_hash) {
    return {
      ok: false,
      error: 'checkpoint_hash_mismatch',
      details: {
        expected_checkpoint_hash: expected.checkpoint_hash,
        provided_checkpoint_hash: provided.checkpoint_hash
      }
    };
  }

  return { ok: true };
}

export function buildSignedPolicyAuditExportPayload({
  exportedAt,
  query,
  entries,
  totalFiltered,
  nextCursor,
  withAttestation,
  withCheckpoint,
  keyId
}) {
  const normalizedQuery = normalizeExportQuery(query);
  const normalizedNextCursor = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;
  const exportHash = buildPolicyAuditExportHash({
    entries,
    totalFiltered,
    query: normalizedQuery,
    nextCursor: normalizedNextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    entries: entries ?? [],
    export_hash: exportHash
  };

  if (normalizedNextCursor) payload.next_cursor = normalizedNextCursor;

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor: normalizedNextCursor,
      exportHash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildPolicyAuditExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null,
      nextCursor: normalizedNextCursor,
      entriesCount: (entries ?? []).length,
      totalFiltered
    });
  }

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
    query: payload.query,
    nextCursor: payload.next_cursor
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

  if (payload.attestation) {
    const attest = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attest.ok) return attest;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
      totalFiltered: payload.total_filtered
    });
    if (!checkpoint.ok) return checkpoint;
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
    query: payload.query,
    nextCursor: payload.next_cursor
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

  if (payload.attestation) {
    const attest = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attest.ok) return attest;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
      totalFiltered: payload.total_filtered
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = exportSignablePayload(payload);

  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
    payload: signable,
    publicKeyPem,
    keyId,
    alg
  });
}

function normalizePartnerProgramRolloutPolicyAuditExportQuery(query) {
  const out = {};

  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  const limit = Number.parseInt(String(query?.limit ?? ''), 10);
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.min(limit, 200);

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();

  return out;
}

function normalizePartnerProgramRolloutPolicyForExport(policy) {
  const allowlist = Array.isArray(policy?.allowlist)
    ? Array.from(new Set(policy.allowlist.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
    : [];

  const updatedBy = policy?.updated_by && typeof policy.updated_by === 'object'
    ? {
        type: typeof policy.updated_by.type === 'string' ? policy.updated_by.type : null,
        id: typeof policy.updated_by.id === 'string' ? policy.updated_by.id : null
      }
    : null;

  const lastAdminActionBy = policy?.controls?.last_admin_action_by && typeof policy.controls.last_admin_action_by === 'object'
    ? {
        type: typeof policy.controls.last_admin_action_by.type === 'string' ? policy.controls.last_admin_action_by.type : null,
        id: typeof policy.controls.last_admin_action_by.id === 'string' ? policy.controls.last_admin_action_by.id : null
      }
    : null;

  return {
    policy_key: typeof policy?.policy_key === 'string' && policy.policy_key.trim() ? policy.policy_key.trim() : 'vault_reconciliation_export',
    source: typeof policy?.source === 'string' && policy.source.trim() ? policy.source.trim() : 'env',
    allowlist,
    allowlist_enforced: allowlist.length > 0,
    min_plan_id: typeof policy?.min_plan_id === 'string' && policy.min_plan_id.trim() ? policy.min_plan_id.trim().toLowerCase() : null,
    version: Number.isFinite(policy?.version) ? Number(policy.version) : null,
    updated_at: typeof policy?.updated_at === 'string' && policy.updated_at.trim() ? policy.updated_at.trim() : null,
    updated_by: updatedBy && updatedBy.type && updatedBy.id ? updatedBy : null,
    controls: {
      maintenance_mode_enabled: policy?.controls?.maintenance_mode_enabled === true,
      maintenance_reason_code: typeof policy?.controls?.maintenance_reason_code === 'string' && policy.controls.maintenance_reason_code.trim()
        ? policy.controls.maintenance_reason_code.trim()
        : null,
      freeze_until: typeof policy?.controls?.freeze_until === 'string' && policy.controls.freeze_until.trim()
        ? policy.controls.freeze_until.trim()
        : null,
      freeze_reason_code: typeof policy?.controls?.freeze_reason_code === 'string' && policy.controls.freeze_reason_code.trim()
        ? policy.controls.freeze_reason_code.trim()
        : null,
      freeze_active: policy?.controls?.freeze_active === true,
      last_admin_action_at: typeof policy?.controls?.last_admin_action_at === 'string' && policy.controls.last_admin_action_at.trim()
        ? policy.controls.last_admin_action_at.trim()
        : null,
      last_admin_action_by: lastAdminActionBy && lastAdminActionBy.type && lastAdminActionBy.id ? lastAdminActionBy : null
    }
  };
}

function partnerProgramRolloutPolicyAuditExportSignablePayload(payload) {
  const out = {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramRolloutPolicyAuditExportQuery(payload?.query),
    policy: normalizePartnerProgramRolloutPolicyForExport(payload?.policy),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    entries: payload?.entries ?? [],
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };

  if (typeof payload?.next_cursor === 'string' && payload.next_cursor.trim()) out.next_cursor = payload.next_cursor.trim();

  const attestation = normalizeExportAttestation(payload?.attestation);
  if (attestation) out.attestation = attestation;

  const checkpoint = normalizeExportCheckpoint(payload?.checkpoint);
  if (checkpoint) out.checkpoint = checkpoint;

  return out;
}

export function buildPartnerProgramRolloutPolicyAuditExportHash({ policy, entries, totalFiltered, query, nextCursor }) {
  const input = {
    policy: normalizePartnerProgramRolloutPolicyForExport(policy),
    entries: entries ?? [],
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    query: normalizePartnerProgramRolloutPolicyAuditExportQuery(query)
  };

  if (typeof nextCursor === 'string' && nextCursor.trim()) input.next_cursor = nextCursor.trim();

  return sha256HexCanonical(input);
}

export function buildSignedPartnerProgramRolloutPolicyAuditExportPayload({
  exportedAt,
  query,
  policy,
  entries,
  totalFiltered,
  nextCursor,
  withAttestation,
  withCheckpoint,
  keyId
}) {
  const normalizedQuery = normalizePartnerProgramRolloutPolicyAuditExportQuery(query);
  const normalizedPolicy = normalizePartnerProgramRolloutPolicyForExport(policy);
  const normalizedNextCursor = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;

  const exportHash = buildPartnerProgramRolloutPolicyAuditExportHash({
    policy: normalizedPolicy,
    entries,
    totalFiltered,
    query: normalizedQuery,
    nextCursor: normalizedNextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    policy: normalizedPolicy,
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    entries: entries ?? [],
    export_hash: exportHash
  };

  if (normalizedNextCursor) payload.next_cursor = normalizedNextCursor;

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor: normalizedNextCursor,
      exportHash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildPolicyAuditExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null,
      nextCursor: normalizedNextCursor,
      entriesCount: (entries ?? []).length,
      totalFiltered
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramRolloutPolicyAuditExportPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildPartnerProgramRolloutPolicyAuditExportHash({
    policy: payload.policy,
    entries: payload.entries,
    totalFiltered: payload.total_filtered,
    query: payload.query,
    nextCursor: payload.next_cursor
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

  if (payload.attestation) {
    const attest = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attest.ok) return attest;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
      totalFiltered: payload.total_filtered
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = partnerProgramRolloutPolicyAuditExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramRolloutPolicyAuditExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildPartnerProgramRolloutPolicyAuditExportHash({
    policy: payload.policy,
    entries: payload.entries,
    totalFiltered: payload.total_filtered,
    query: payload.query,
    nextCursor: payload.next_cursor
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

  if (payload.attestation) {
    const attest = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attest.ok) return attest;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
      totalFiltered: payload.total_filtered
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = partnerProgramRolloutPolicyAuditExportSignablePayload(payload);

  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
    payload: signable,
    publicKeyPem,
    keyId,
    alg
  });
}

function normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(query) {
  const out = {};

  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  if (typeof query?.include_recommended_actions === 'boolean') out.include_recommended_actions = query.include_recommended_actions;
  if (typeof query?.include_runbook_hooks === 'boolean') out.include_runbook_hooks = query.include_runbook_hooks;
  if (typeof query?.include_automation_hints === 'boolean') out.include_automation_hints = query.include_automation_hints;

  const maintenanceStaleAfter = Number.parseInt(String(query?.maintenance_stale_after_minutes ?? ''), 10);
  if (Number.isFinite(maintenanceStaleAfter) && maintenanceStaleAfter > 0) out.maintenance_stale_after_minutes = maintenanceStaleAfter;

  const freezeExpiringSoon = Number.parseInt(String(query?.freeze_expiring_soon_minutes ?? ''), 10);
  if (Number.isFinite(freezeExpiringSoon) && freezeExpiringSoon > 0) out.freeze_expiring_soon_minutes = freezeExpiringSoon;

  const automationMaxActions = Number.parseInt(String(query?.automation_max_actions ?? ''), 10);
  if (Number.isFinite(automationMaxActions) && automationMaxActions > 0) out.automation_max_actions = automationMaxActions;

  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();

  return out;
}

function normalizePartnerProgramRolloutPolicyDiagnosticsOverlays(overlays) {
  const adminAllowlist = Array.isArray(overlays?.admin_allowlist)
    ? Array.from(new Set(overlays.admin_allowlist.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
    : [];

  const settlementRetention = Number.isFinite(overlays?.settlement_export_checkpoint_retention_days)
    ? Math.max(1, Number(overlays.settlement_export_checkpoint_retention_days))
    : 30;

  const policyAuditRetention = Number.isFinite(overlays?.rollout_policy_audit_checkpoint_retention_days)
    ? Math.max(1, Number(overlays.rollout_policy_audit_checkpoint_retention_days))
    : 30;

  const diagnosticsRetention = Number.isFinite(overlays?.rollout_policy_diagnostics_checkpoint_retention_days)
    ? Math.max(1, Number(overlays.rollout_policy_diagnostics_checkpoint_retention_days))
    : 30;

  return {
    partner_program_enforced: overlays?.partner_program_enforced === true,
    settlement_export_checkpoint_enforced: overlays?.settlement_export_checkpoint_enforced === true,
    settlement_export_checkpoint_retention_days: settlementRetention,
    rollout_policy_audit_checkpoint_enforced: overlays?.rollout_policy_audit_checkpoint_enforced === true,
    rollout_policy_audit_checkpoint_retention_days: policyAuditRetention,
    rollout_policy_diagnostics_checkpoint_enforced: overlays?.rollout_policy_diagnostics_checkpoint_enforced === true,
    rollout_policy_diagnostics_checkpoint_retention_days: diagnosticsRetention,
    freeze_export_enforced: overlays?.freeze_export_enforced === true,
    admin_allowlist: adminAllowlist
  };
}

function normalizePartnerProgramRolloutPolicyDiagnosticsActions(actions) {
  if (!Array.isArray(actions)) return [];

  return actions.map(action => {
    const details = action?.details && typeof action.details === 'object' && !Array.isArray(action.details)
      ? clone(action.details)
      : {};

    return {
      code: typeof action?.code === 'string' ? action.code : null,
      reason_code: typeof action?.reason_code === 'string' ? action.reason_code : null,
      runbook_hook_id: typeof action?.runbook_hook_id === 'string' ? action.runbook_hook_id : null,
      details
    };
  });
}

function normalizePartnerProgramRolloutPolicyDiagnosticsRunbookHooks(hooks) {
  if (!Array.isArray(hooks)) return [];

  return hooks.map(hook => {
    const action = hook?.action && typeof hook.action === 'object' && !Array.isArray(hook.action)
      ? {
          action_type: typeof hook.action.action_type === 'string' ? hook.action.action_type : null,
          maintenance_mode_enabled: typeof hook.action.maintenance_mode_enabled === 'boolean' ? hook.action.maintenance_mode_enabled : undefined,
          maintenance_reason_code: typeof hook.action.maintenance_reason_code === 'string' && hook.action.maintenance_reason_code.trim()
            ? hook.action.maintenance_reason_code.trim()
            : undefined,
          freeze_until: typeof hook.action.freeze_until === 'string' && hook.action.freeze_until.trim() ? hook.action.freeze_until.trim() : undefined,
          freeze_reason_code: typeof hook.action.freeze_reason_code === 'string' && hook.action.freeze_reason_code.trim()
            ? hook.action.freeze_reason_code.trim()
            : undefined
        }
      : { action_type: null };

    return {
      hook_id: typeof hook?.hook_id === 'string' ? hook.hook_id : null,
      operation_id: typeof hook?.operation_id === 'string' ? hook.operation_id : null,
      action: Object.fromEntries(Object.entries(action).filter(([, v]) => v !== undefined))
    };
  });
}

function normalizePartnerProgramRolloutPolicyDiagnosticsLifecycleSignals(lifecycleSignals) {
  const maintenanceModeAgeMinutes = Number.isFinite(lifecycleSignals?.maintenance_mode_age_minutes)
    ? Number(lifecycleSignals.maintenance_mode_age_minutes)
    : null;

  const freezeWindowRemainingMinutes = Number.isFinite(lifecycleSignals?.freeze_window_remaining_minutes)
    ? Number(lifecycleSignals.freeze_window_remaining_minutes)
    : null;

  const freezeBucket = typeof lifecycleSignals?.freeze_window_remaining_bucket === 'string' && lifecycleSignals.freeze_window_remaining_bucket.trim()
    ? lifecycleSignals.freeze_window_remaining_bucket.trim()
    : 'none';

  return {
    maintenance_mode_age_minutes: maintenanceModeAgeMinutes,
    freeze_window_remaining_minutes: freezeWindowRemainingMinutes,
    freeze_window_remaining_bucket: freezeBucket
  };
}

function normalizePartnerProgramRolloutPolicyDiagnosticsAlerts(alerts) {
  if (!Array.isArray(alerts)) return [];

  return alerts.map(alert => {
    const details = alert?.details && typeof alert.details === 'object' && !Array.isArray(alert.details)
      ? clone(alert.details)
      : {};

    return {
      code: typeof alert?.code === 'string' ? alert.code : null,
      severity: typeof alert?.severity === 'string' ? alert.severity : null,
      reason_code: typeof alert?.reason_code === 'string' ? alert.reason_code : null,
      details
    };
  });
}

function normalizePartnerProgramRolloutPolicyDiagnosticsAutomationHints(automationHints) {
  if (!automationHints || typeof automationHints !== 'object' || Array.isArray(automationHints)) {
    return null;
  }

  const sourceAlertCodes = Array.isArray(automationHints.source_alert_codes)
    ? automationHints.source_alert_codes.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
    : [];

  const actionQueue = Array.isArray(automationHints.action_queue)
    ? automationHints.action_queue.map(action => ({
        hook_id: typeof action?.hook_id === 'string' ? action.hook_id : null,
        reason_code: typeof action?.reason_code === 'string' ? action.reason_code : null,
        priority: typeof action?.priority === 'string' ? action.priority : null
      }))
    : [];

  const actionRequests = Array.isArray(automationHints.action_requests)
    ? automationHints.action_requests.map(request => {
        const step = Number.parseInt(String(request?.step ?? ''), 10);

        const action = request?.request?.action && typeof request.request.action === 'object' && !Array.isArray(request.request.action)
          ? {
              action_type: typeof request.request.action.action_type === 'string' ? request.request.action.action_type : null,
              maintenance_mode_enabled: typeof request.request.action.maintenance_mode_enabled === 'boolean'
                ? request.request.action.maintenance_mode_enabled
                : undefined,
              maintenance_reason_code: typeof request.request.action.maintenance_reason_code === 'string' && request.request.action.maintenance_reason_code.trim()
                ? request.request.action.maintenance_reason_code.trim()
                : undefined,
              freeze_until: typeof request.request.action.freeze_until === 'string' && request.request.action.freeze_until.trim()
                ? request.request.action.freeze_until.trim()
                : undefined,
              freeze_reason_code: typeof request.request.action.freeze_reason_code === 'string' && request.request.action.freeze_reason_code.trim()
                ? request.request.action.freeze_reason_code.trim()
                : undefined
            }
          : { action_type: null };

        const requestHash = typeof request?.request_hash === 'string' && request.request_hash.trim()
          ? request.request_hash.trim()
          : null;

        const policyVersionAfter = Number.parseInt(String(request?.expected_effect?.policy_version_after ?? ''), 10);
        const freezeUntilAfter = typeof request?.expected_effect?.freeze_until === 'string' && request.expected_effect.freeze_until.trim()
          ? request.expected_effect.freeze_until.trim()
          : null;

        return {
          step: Number.isFinite(step) && step > 0 ? step : null,
          hook_id: typeof request?.hook_id === 'string' ? request.hook_id : null,
          operation_id: typeof request?.operation_id === 'string' ? request.operation_id : null,
          idempotency_key_template: typeof request?.idempotency_key_template === 'string' ? request.idempotency_key_template : null,
          request_hash: requestHash,
          request: {
            action: Object.fromEntries(Object.entries(action).filter(([, v]) => v !== undefined))
          },
          expected_effect: {
            policy_version_after: Number.isFinite(policyVersionAfter) && policyVersionAfter > 0 ? policyVersionAfter : null,
            maintenance_mode_enabled: request?.expected_effect?.maintenance_mode_enabled === true,
            freeze_until: freezeUntilAfter,
            freeze_active: request?.expected_effect?.freeze_active === true
          }
        };
      })
    : [];

  const maxActionsPerRun = Number.parseInt(String(automationHints?.safety?.max_actions_per_run ?? ''), 10);
  const idempotencyScope = typeof automationHints?.safety?.idempotency_scope === 'string' && automationHints.safety.idempotency_scope.trim()
    ? automationHints.safety.idempotency_scope.trim()
    : 'partnerProgram.vault_export.rollout_policy.admin_action';
  const planHash = typeof automationHints?.plan_hash === 'string' && automationHints.plan_hash.trim()
    ? automationHints.plan_hash.trim()
    : null;

  const executionPolicyVersionBefore = Number.parseInt(String(automationHints?.execution_attestation?.policy_version_before ?? ''), 10);
  const executionPolicyVersionAfterExpected = Number.parseInt(String(automationHints?.execution_attestation?.policy_version_after_expected ?? ''), 10);
  const executionExpectedEffectHash = typeof automationHints?.execution_attestation?.expected_effect_hash === 'string' && automationHints.execution_attestation.expected_effect_hash.trim()
    ? automationHints.execution_attestation.expected_effect_hash.trim()
    : null;
  const executionRequestHashChain = typeof automationHints?.execution_attestation?.request_hash_chain === 'string' && automationHints.execution_attestation.request_hash_chain.trim()
    ? automationHints.execution_attestation.request_hash_chain.trim()
    : null;
  const executionAttestationHash = typeof automationHints?.execution_attestation?.attestation_hash === 'string' && automationHints.execution_attestation.attestation_hash.trim()
    ? automationHints.execution_attestation.attestation_hash.trim()
    : null;

  return {
    requires_operator_confirmation: automationHints.requires_operator_confirmation === true,
    source_alert_codes: sourceAlertCodes,
    action_queue: actionQueue,
    action_requests: actionRequests,
    plan_hash: planHash,
    execution_attestation: {
      policy_version_before: Number.isFinite(executionPolicyVersionBefore) && executionPolicyVersionBefore > 0 ? executionPolicyVersionBefore : 0,
      policy_version_after_expected: Number.isFinite(executionPolicyVersionAfterExpected) && executionPolicyVersionAfterExpected > 0
        ? executionPolicyVersionAfterExpected
        : (Number.isFinite(executionPolicyVersionBefore) && executionPolicyVersionBefore > 0 ? executionPolicyVersionBefore : 0),
      non_empty_action_plan: automationHints?.execution_attestation?.non_empty_action_plan === true,
      expected_effect_hash: executionExpectedEffectHash,
      request_hash_chain: executionRequestHashChain,
      attestation_hash: executionAttestationHash
    },
    safety: {
      idempotency_required: automationHints?.safety?.idempotency_required !== false,
      idempotency_scope: idempotencyScope,
      max_actions_per_run: Number.isFinite(maxActionsPerRun) && maxActionsPerRun > 0 ? maxActionsPerRun : 1
    }
  };
}

function buildPartnerProgramRolloutPolicyDiagnosticsAutomationPlanHash(automationHints) {
  return sha256HexCanonical({
    source_alert_codes: automationHints?.source_alert_codes ?? [],
    action_queue: automationHints?.action_queue ?? [],
    action_requests: (automationHints?.action_requests ?? []).map(request => ({
      step: request?.step ?? null,
      hook_id: request?.hook_id ?? null,
      operation_id: request?.operation_id ?? null,
      idempotency_key_template: request?.idempotency_key_template ?? null,
      request_hash: request?.request_hash ?? null,
      expected_effect: request?.expected_effect ?? null
    })),
    safety: automationHints?.safety ?? null
  });
}

function buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionExpectedEffectHash(actionRequests) {
  return sha256HexCanonical((actionRequests ?? []).map(request => ({
    step: request?.step ?? null,
    expected_effect: request?.expected_effect ?? null
  })));
}

function buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionRequestHashChain(actionRequests) {
  return sha256HexCanonical((actionRequests ?? []).map(request => request?.request_hash ?? null));
}

function buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionAttestationHash({ planHash, executionAttestation }) {
  return sha256HexCanonical({
    plan_hash: planHash ?? null,
    policy_version_before: executionAttestation?.policy_version_before ?? 0,
    policy_version_after_expected: executionAttestation?.policy_version_after_expected ?? 0,
    non_empty_action_plan: executionAttestation?.non_empty_action_plan === true,
    expected_effect_hash: executionAttestation?.expected_effect_hash ?? null,
    request_hash_chain: executionAttestation?.request_hash_chain ?? null
  });
}

function verifyPartnerProgramRolloutPolicyDiagnosticsAutomationHintsConsistency({ policy, automationHints }) {
  const normalizedAutomationHints = normalizePartnerProgramRolloutPolicyDiagnosticsAutomationHints(automationHints);
  if (!normalizedAutomationHints) {
    return { ok: true };
  }

  const actionRequests = Array.isArray(normalizedAutomationHints.action_requests)
    ? normalizedAutomationHints.action_requests
    : [];

  const expectedPolicyVersionBefore = Number.isFinite(policy?.version) && policy.version > 0
    ? Number(policy.version)
    : 0;

  if (normalizedAutomationHints.execution_attestation.policy_version_before !== expectedPolicyVersionBefore) {
    return {
      ok: false,
      error: 'automation_execution_policy_version_before_mismatch',
      details: {
        expected_policy_version_before: expectedPolicyVersionBefore,
        provided_policy_version_before: normalizedAutomationHints.execution_attestation.policy_version_before
      }
    };
  }

  const expectedPlanHash = buildPartnerProgramRolloutPolicyDiagnosticsAutomationPlanHash(normalizedAutomationHints);
  if (normalizedAutomationHints.plan_hash !== expectedPlanHash) {
    return {
      ok: false,
      error: 'automation_plan_hash_mismatch',
      details: {
        expected_plan_hash: expectedPlanHash,
        provided_plan_hash: normalizedAutomationHints.plan_hash
      }
    };
  }

  const lastExpectedPolicyVersion = actionRequests.length > 0
    ? actionRequests[actionRequests.length - 1]?.expected_effect?.policy_version_after
    : null;
  const expectedPolicyVersionAfterExpected = Number.isFinite(lastExpectedPolicyVersion) && lastExpectedPolicyVersion > 0
    ? Number(lastExpectedPolicyVersion)
    : expectedPolicyVersionBefore;

  if (normalizedAutomationHints.execution_attestation.policy_version_after_expected !== expectedPolicyVersionAfterExpected) {
    return {
      ok: false,
      error: 'automation_execution_policy_version_after_expected_mismatch',
      details: {
        expected_policy_version_after_expected: expectedPolicyVersionAfterExpected,
        provided_policy_version_after_expected: normalizedAutomationHints.execution_attestation.policy_version_after_expected
      }
    };
  }

  const expectedNonEmptyActionPlan = actionRequests.length > 0;
  if (normalizedAutomationHints.execution_attestation.non_empty_action_plan !== expectedNonEmptyActionPlan) {
    return {
      ok: false,
      error: 'automation_execution_non_empty_action_plan_mismatch',
      details: {
        expected_non_empty_action_plan: expectedNonEmptyActionPlan,
        provided_non_empty_action_plan: normalizedAutomationHints.execution_attestation.non_empty_action_plan
      }
    };
  }

  const expectedEffectHash = buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionExpectedEffectHash(actionRequests);
  if (normalizedAutomationHints.execution_attestation.expected_effect_hash !== expectedEffectHash) {
    return {
      ok: false,
      error: 'automation_execution_expected_effect_hash_mismatch',
      details: {
        expected_expected_effect_hash: expectedEffectHash,
        provided_expected_effect_hash: normalizedAutomationHints.execution_attestation.expected_effect_hash
      }
    };
  }

  const expectedRequestHashChain = buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionRequestHashChain(actionRequests);
  if (normalizedAutomationHints.execution_attestation.request_hash_chain !== expectedRequestHashChain) {
    return {
      ok: false,
      error: 'automation_execution_request_hash_chain_mismatch',
      details: {
        expected_request_hash_chain: expectedRequestHashChain,
        provided_request_hash_chain: normalizedAutomationHints.execution_attestation.request_hash_chain
      }
    };
  }

  const expectedAttestationHash = buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionAttestationHash({
    planHash: normalizedAutomationHints.plan_hash,
    executionAttestation: normalizedAutomationHints.execution_attestation
  });

  if (normalizedAutomationHints.execution_attestation.attestation_hash !== expectedAttestationHash) {
    return {
      ok: false,
      error: 'automation_execution_attestation_hash_mismatch',
      details: {
        expected_attestation_hash: expectedAttestationHash,
        provided_attestation_hash: normalizedAutomationHints.execution_attestation.attestation_hash
      }
    };
  }

  return { ok: true };
}

function buildPartnerProgramRolloutPolicyDiagnosticsExportAttestation({ query, exportHash }) {
  const normalizedQuery = normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(query);
  const attestationAfter = typeof normalizedQuery.attestation_after === 'string' ? normalizedQuery.attestation_after : null;

  const attestationInput = {
    cursor_after: null,
    next_cursor: null,
    attestation_after: attestationAfter,
    page_hash: exportHash
  };

  return {
    ...attestationInput,
    chain_hash: sha256HexCanonical(attestationInput)
  };
}

function verifyPartnerProgramRolloutPolicyDiagnosticsExportAttestation({ attestation, query, exportHash }) {
  const provided = normalizeExportAttestation(attestation);
  if (!provided) return { ok: false, error: 'attestation_missing' };

  const expected = buildPartnerProgramRolloutPolicyDiagnosticsExportAttestation({ query, exportHash });

  if (provided.page_hash !== expected.page_hash) {
    return {
      ok: false,
      error: 'attestation_page_hash_mismatch',
      details: {
        expected_page_hash: expected.page_hash,
        provided_page_hash: provided.page_hash
      }
    };
  }

  if (provided.cursor_after !== expected.cursor_after) {
    return {
      ok: false,
      error: 'attestation_cursor_mismatch',
      details: {
        expected_cursor_after: expected.cursor_after,
        provided_cursor_after: provided.cursor_after
      }
    };
  }

  if (provided.next_cursor !== expected.next_cursor) {
    return {
      ok: false,
      error: 'attestation_next_cursor_mismatch',
      details: {
        expected_next_cursor: expected.next_cursor,
        provided_next_cursor: provided.next_cursor
      }
    };
  }

  if (provided.attestation_after !== expected.attestation_after) {
    return {
      ok: false,
      error: 'attestation_after_mismatch',
      details: {
        expected_attestation_after: expected.attestation_after,
        provided_attestation_after: provided.attestation_after
      }
    };
  }

  if (provided.chain_hash !== expected.chain_hash) {
    return {
      ok: false,
      error: 'attestation_chain_hash_mismatch',
      details: {
        expected_chain_hash: expected.chain_hash,
        provided_chain_hash: provided.chain_hash
      }
    };
  }

  return { ok: true };
}

function buildPartnerProgramRolloutPolicyDiagnosticsExportCheckpoint({ query, attestation }) {
  const normalizedQuery = normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(query);
  const checkpointAfter = typeof normalizedQuery.checkpoint_after === 'string' ? normalizedQuery.checkpoint_after : null;
  const attestationChainHash = typeof attestation?.chain_hash === 'string' ? attestation.chain_hash : null;

  const checkpointInput = {
    checkpoint_after: checkpointAfter,
    attestation_chain_hash: attestationChainHash,
    next_cursor: null,
    entries_count: 0,
    total_filtered: 0
  };

  return {
    ...checkpointInput,
    checkpoint_hash: sha256HexCanonical(checkpointInput)
  };
}

function verifyPartnerProgramRolloutPolicyDiagnosticsExportCheckpoint({ checkpoint, query, attestation }) {
  const provided = normalizeExportCheckpoint(checkpoint);
  if (!provided) return { ok: false, error: 'checkpoint_missing' };

  const expected = buildPartnerProgramRolloutPolicyDiagnosticsExportCheckpoint({
    query,
    attestation
  });

  if (provided.checkpoint_after !== expected.checkpoint_after) {
    return {
      ok: false,
      error: 'checkpoint_after_mismatch',
      details: {
        expected_checkpoint_after: expected.checkpoint_after,
        provided_checkpoint_after: provided.checkpoint_after
      }
    };
  }

  if (provided.attestation_chain_hash !== expected.attestation_chain_hash) {
    return {
      ok: false,
      error: 'checkpoint_attestation_mismatch',
      details: {
        expected_attestation_chain_hash: expected.attestation_chain_hash,
        provided_attestation_chain_hash: provided.attestation_chain_hash
      }
    };
  }

  if (provided.next_cursor !== expected.next_cursor) {
    return {
      ok: false,
      error: 'checkpoint_next_cursor_mismatch',
      details: {
        expected_next_cursor: expected.next_cursor,
        provided_next_cursor: provided.next_cursor
      }
    };
  }

  if (provided.entries_count !== expected.entries_count) {
    return {
      ok: false,
      error: 'checkpoint_entries_count_mismatch',
      details: {
        expected_entries_count: expected.entries_count,
        provided_entries_count: provided.entries_count
      }
    };
  }

  if (provided.total_filtered !== expected.total_filtered) {
    return {
      ok: false,
      error: 'checkpoint_total_filtered_mismatch',
      details: {
        expected_total_filtered: expected.total_filtered,
        provided_total_filtered: provided.total_filtered
      }
    };
  }

  if (provided.checkpoint_hash !== expected.checkpoint_hash) {
    return {
      ok: false,
      error: 'checkpoint_hash_mismatch',
      details: {
        expected_checkpoint_hash: expected.checkpoint_hash,
        provided_checkpoint_hash: provided.checkpoint_hash
      }
    };
  }

  return { ok: true };
}

function partnerProgramRolloutPolicyDiagnosticsExportSignablePayload(payload) {
  const out = {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(payload?.query),
    policy: normalizePartnerProgramRolloutPolicyForExport(payload?.policy),
    overlays: normalizePartnerProgramRolloutPolicyDiagnosticsOverlays(payload?.overlays),
    lifecycle_signals: normalizePartnerProgramRolloutPolicyDiagnosticsLifecycleSignals(payload?.lifecycle_signals),
    alerts: normalizePartnerProgramRolloutPolicyDiagnosticsAlerts(payload?.alerts),
    recommended_actions: normalizePartnerProgramRolloutPolicyDiagnosticsActions(payload?.recommended_actions),
    runbook_hooks: normalizePartnerProgramRolloutPolicyDiagnosticsRunbookHooks(payload?.runbook_hooks),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };

  const automationHints = normalizePartnerProgramRolloutPolicyDiagnosticsAutomationHints(payload?.automation_hints);
  if (automationHints) out.automation_hints = automationHints;

  const attestation = normalizeExportAttestation(payload?.attestation);
  if (attestation) out.attestation = attestation;

  const checkpoint = normalizeExportCheckpoint(payload?.checkpoint);
  if (checkpoint) out.checkpoint = checkpoint;

  return out;
}

export function buildPartnerProgramRolloutPolicyDiagnosticsExportHash({
  policy,
  query,
  overlays,
  lifecycleSignals,
  alerts,
  recommendedActions,
  runbookHooks,
  automationHints
}) {
  const out = {
    query: normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(query),
    policy: normalizePartnerProgramRolloutPolicyForExport(policy),
    overlays: normalizePartnerProgramRolloutPolicyDiagnosticsOverlays(overlays),
    lifecycle_signals: normalizePartnerProgramRolloutPolicyDiagnosticsLifecycleSignals(lifecycleSignals),
    alerts: normalizePartnerProgramRolloutPolicyDiagnosticsAlerts(alerts),
    recommended_actions: normalizePartnerProgramRolloutPolicyDiagnosticsActions(recommendedActions),
    runbook_hooks: normalizePartnerProgramRolloutPolicyDiagnosticsRunbookHooks(runbookHooks)
  };

  const normalizedAutomationHints = normalizePartnerProgramRolloutPolicyDiagnosticsAutomationHints(automationHints);
  if (normalizedAutomationHints) out.automation_hints = normalizedAutomationHints;

  return sha256HexCanonical(out);
}

export function buildSignedPartnerProgramRolloutPolicyDiagnosticsExportPayload({
  exportedAt,
  query,
  policy,
  overlays,
  lifecycleSignals,
  alerts,
  recommendedActions,
  runbookHooks,
  automationHints,
  withAttestation = false,
  withCheckpoint = false,
  keyId
}) {
  const normalizedQuery = normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(query);
  const normalizedPolicy = normalizePartnerProgramRolloutPolicyForExport(policy);
  const normalizedOverlays = normalizePartnerProgramRolloutPolicyDiagnosticsOverlays(overlays);
  const normalizedLifecycleSignals = normalizePartnerProgramRolloutPolicyDiagnosticsLifecycleSignals(lifecycleSignals);
  const normalizedAlerts = normalizePartnerProgramRolloutPolicyDiagnosticsAlerts(alerts);
  const normalizedActions = normalizePartnerProgramRolloutPolicyDiagnosticsActions(recommendedActions);
  const normalizedHooks = normalizePartnerProgramRolloutPolicyDiagnosticsRunbookHooks(runbookHooks);
  const normalizedAutomationHints = normalizePartnerProgramRolloutPolicyDiagnosticsAutomationHints(automationHints);

  const exportHash = buildPartnerProgramRolloutPolicyDiagnosticsExportHash({
    query: normalizedQuery,
    policy: normalizedPolicy,
    overlays: normalizedOverlays,
    lifecycleSignals: normalizedLifecycleSignals,
    alerts: normalizedAlerts,
    recommendedActions: normalizedActions,
    runbookHooks: normalizedHooks,
    automationHints: normalizedAutomationHints
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    policy: normalizedPolicy,
    overlays: normalizedOverlays,
    lifecycle_signals: normalizedLifecycleSignals,
    alerts: normalizedAlerts,
    recommended_actions: normalizedActions,
    runbook_hooks: normalizedHooks,
    export_hash: exportHash
  };

  if (normalizedAutomationHints) {
    payload.automation_hints = normalizedAutomationHints;
  }

  if (withAttestation) {
    payload.attestation = buildPartnerProgramRolloutPolicyDiagnosticsExportAttestation({
      query: normalizedQuery,
      exportHash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildPartnerProgramRolloutPolicyDiagnosticsExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramRolloutPolicyDiagnosticsExportPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildPartnerProgramRolloutPolicyDiagnosticsExportHash({
    query: payload.query,
    policy: payload.policy,
    overlays: payload.overlays,
    lifecycleSignals: payload.lifecycle_signals,
    alerts: payload.alerts,
    recommendedActions: payload.recommended_actions,
    runbookHooks: payload.runbook_hooks,
    automationHints: payload.automation_hints
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

  const automationConsistency = verifyPartnerProgramRolloutPolicyDiagnosticsAutomationHintsConsistency({
    policy: payload.policy,
    automationHints: payload.automation_hints
  });
  if (!automationConsistency.ok) return automationConsistency;

  if (payload.attestation) {
    const attestation = verifyPartnerProgramRolloutPolicyDiagnosticsExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      exportHash: payload.export_hash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPartnerProgramRolloutPolicyDiagnosticsExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = partnerProgramRolloutPolicyDiagnosticsExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramRolloutPolicyDiagnosticsExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildPartnerProgramRolloutPolicyDiagnosticsExportHash({
    query: payload.query,
    policy: payload.policy,
    overlays: payload.overlays,
    lifecycleSignals: payload.lifecycle_signals,
    alerts: payload.alerts,
    recommendedActions: payload.recommended_actions,
    runbookHooks: payload.runbook_hooks,
    automationHints: payload.automation_hints
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

  const automationConsistency = verifyPartnerProgramRolloutPolicyDiagnosticsAutomationHintsConsistency({
    policy: payload.policy,
    automationHints: payload.automation_hints
  });
  if (!automationConsistency.ok) return automationConsistency;

  if (payload.attestation) {
    const attestation = verifyPartnerProgramRolloutPolicyDiagnosticsExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      exportHash: payload.export_hash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPartnerProgramRolloutPolicyDiagnosticsExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = partnerProgramRolloutPolicyDiagnosticsExportSignablePayload(payload);

  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
    payload: signable,
    publicKeyPem,
    keyId,
    alg
  });
}

function normalizeVaultReconciliationExportQuery(query) {
  const out = {};

  if (typeof query?.cycle_id === 'string' && query.cycle_id.trim()) out.cycle_id = query.cycle_id.trim();

  if (typeof query?.include_transitions === 'boolean') {
    out.include_transitions = query.include_transitions;
  }

  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  const limit = Number.parseInt(String(query?.limit ?? ''), 10);
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.min(limit, 200);

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();

  return out;
}

function buildSettlementVaultReconciliationExportAttestation({ query, nextCursor, exportHash }) {
  const normalizedQuery = normalizeVaultReconciliationExportQuery(query);
  const cursorAfter = typeof normalizedQuery.cursor_after === 'string' ? normalizedQuery.cursor_after : null;
  const attestationAfter = typeof normalizedQuery.attestation_after === 'string' ? normalizedQuery.attestation_after : null;
  const next = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;

  const attestationInput = {
    cursor_after: cursorAfter,
    next_cursor: next,
    attestation_after: attestationAfter,
    page_hash: exportHash
  };

  return {
    ...attestationInput,
    chain_hash: sha256HexCanonical(attestationInput)
  };
}

function verifySettlementVaultReconciliationExportAttestation({ attestation, query, nextCursor, exportHash }) {
  const provided = normalizeExportAttestation(attestation);
  if (!provided) return { ok: false, error: 'attestation_missing' };

  const expected = buildSettlementVaultReconciliationExportAttestation({ query, nextCursor, exportHash });

  if (provided.page_hash !== expected.page_hash) {
    return {
      ok: false,
      error: 'attestation_page_hash_mismatch',
      details: {
        expected_page_hash: expected.page_hash,
        provided_page_hash: provided.page_hash
      }
    };
  }

  if (provided.cursor_after !== expected.cursor_after) {
    return {
      ok: false,
      error: 'attestation_cursor_mismatch',
      details: {
        expected_cursor_after: expected.cursor_after,
        provided_cursor_after: provided.cursor_after
      }
    };
  }

  if (provided.next_cursor !== expected.next_cursor) {
    return {
      ok: false,
      error: 'attestation_next_cursor_mismatch',
      details: {
        expected_next_cursor: expected.next_cursor,
        provided_next_cursor: provided.next_cursor
      }
    };
  }

  if (provided.attestation_after !== expected.attestation_after) {
    return {
      ok: false,
      error: 'attestation_after_mismatch',
      details: {
        expected_attestation_after: expected.attestation_after,
        provided_attestation_after: provided.attestation_after
      }
    };
  }

  if (provided.chain_hash !== expected.chain_hash) {
    return {
      ok: false,
      error: 'attestation_chain_hash_mismatch',
      details: {
        expected_chain_hash: expected.chain_hash,
        provided_chain_hash: provided.chain_hash
      }
    };
  }

  return { ok: true };
}

function buildSettlementVaultReconciliationExportCheckpoint({ query, attestation, nextCursor, entriesCount, totalFiltered }) {
  const normalizedQuery = normalizeVaultReconciliationExportQuery(query);
  const checkpointAfter = typeof normalizedQuery.checkpoint_after === 'string' ? normalizedQuery.checkpoint_after : null;
  const attestationChainHash = typeof attestation?.chain_hash === 'string' ? attestation.chain_hash : null;
  const next = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;

  const checkpointInput = {
    checkpoint_after: checkpointAfter,
    attestation_chain_hash: attestationChainHash,
    next_cursor: next,
    entries_count: Number.isFinite(entriesCount) ? Number(entriesCount) : 0,
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0
  };

  return {
    ...checkpointInput,
    checkpoint_hash: sha256HexCanonical(checkpointInput)
  };
}

function verifySettlementVaultReconciliationExportCheckpoint({ checkpoint, query, attestation, nextCursor, entriesCount, totalFiltered }) {
  const provided = normalizeExportCheckpoint(checkpoint);
  if (!provided) return { ok: false, error: 'checkpoint_missing' };

  const expected = buildSettlementVaultReconciliationExportCheckpoint({
    query,
    attestation,
    nextCursor,
    entriesCount,
    totalFiltered
  });

  if (provided.checkpoint_after !== expected.checkpoint_after) {
    return {
      ok: false,
      error: 'checkpoint_after_mismatch',
      details: {
        expected_checkpoint_after: expected.checkpoint_after,
        provided_checkpoint_after: provided.checkpoint_after
      }
    };
  }

  if (provided.attestation_chain_hash !== expected.attestation_chain_hash) {
    return {
      ok: false,
      error: 'checkpoint_attestation_mismatch',
      details: {
        expected_attestation_chain_hash: expected.attestation_chain_hash,
        provided_attestation_chain_hash: provided.attestation_chain_hash
      }
    };
  }

  if (provided.next_cursor !== expected.next_cursor) {
    return {
      ok: false,
      error: 'checkpoint_next_cursor_mismatch',
      details: {
        expected_next_cursor: expected.next_cursor,
        provided_next_cursor: provided.next_cursor
      }
    };
  }

  if (provided.entries_count !== expected.entries_count) {
    return {
      ok: false,
      error: 'checkpoint_entries_count_mismatch',
      details: {
        expected_entries_count: expected.entries_count,
        provided_entries_count: provided.entries_count
      }
    };
  }

  if (provided.total_filtered !== expected.total_filtered) {
    return {
      ok: false,
      error: 'checkpoint_total_filtered_mismatch',
      details: {
        expected_total_filtered: expected.total_filtered,
        provided_total_filtered: provided.total_filtered
      }
    };
  }

  if (provided.checkpoint_hash !== expected.checkpoint_hash) {
    return {
      ok: false,
      error: 'checkpoint_hash_mismatch',
      details: {
        expected_checkpoint_hash: expected.checkpoint_hash,
        provided_checkpoint_hash: provided.checkpoint_hash
      }
    };
  }

  return { ok: true };
}

function vaultReconciliationExportSignablePayload(payload) {
  const out = {
    exported_at: payload?.exported_at,
    query: normalizeVaultReconciliationExportQuery(payload?.query),
    cycle_id: payload?.cycle_id,
    timeline_state: payload?.timeline_state,
    vault_reconciliation: payload?.vault_reconciliation,
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };

  if (Array.isArray(payload?.state_transitions)) {
    out.state_transitions = payload.state_transitions;
  }

  if (Number.isFinite(payload?.total_filtered)) {
    out.total_filtered = Number(payload.total_filtered);
  }

  if (typeof payload?.next_cursor === 'string' && payload.next_cursor.trim()) {
    out.next_cursor = payload.next_cursor.trim();
  }

  const attestation = normalizeExportAttestation(payload?.attestation);
  if (attestation) out.attestation = attestation;

  const checkpoint = normalizeExportCheckpoint(payload?.checkpoint);
  if (checkpoint) out.checkpoint = checkpoint;

  return out;
}

export function buildSettlementVaultReconciliationExportHash({
  cycleId,
  timelineState,
  vaultReconciliation,
  stateTransitions,
  totalFiltered,
  nextCursor,
  query
}) {
  const input = {
    cycle_id: String(cycleId ?? ''),
    timeline_state: String(timelineState ?? ''),
    vault_reconciliation: vaultReconciliation ?? null,
    query: normalizeVaultReconciliationExportQuery(query)
  };

  if (Array.isArray(stateTransitions)) {
    input.state_transitions = stateTransitions;
  }

  if (Number.isFinite(totalFiltered)) {
    input.total_filtered = Number(totalFiltered);
  }

  if (typeof nextCursor === 'string' && nextCursor.trim()) {
    input.next_cursor = nextCursor.trim();
  }

  return sha256HexCanonical(input);
}

export function buildSignedSettlementVaultReconciliationExportPayload({
  exportedAt,
  cycleId,
  timelineState,
  vaultReconciliation,
  stateTransitions,
  totalFiltered,
  nextCursor,
  withAttestation,
  withCheckpoint,
  query,
  keyId
}) {
  const normalizedQuery = normalizeVaultReconciliationExportQuery(query);
  const normalizedNextCursor = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor.trim() : null;
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : null;

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    cycle_id: cycleId,
    timeline_state: timelineState,
    vault_reconciliation: vaultReconciliation
  };

  if (Array.isArray(stateTransitions)) {
    payload.state_transitions = stateTransitions;
  }

  if (normalizedTotalFiltered !== null) {
    payload.total_filtered = normalizedTotalFiltered;
  }

  if (normalizedNextCursor) {
    payload.next_cursor = normalizedNextCursor;
  }

  payload.export_hash = buildSettlementVaultReconciliationExportHash({
    cycleId,
    timelineState,
    vaultReconciliation,
    stateTransitions,
    totalFiltered: normalizedTotalFiltered,
    nextCursor: normalizedNextCursor,
    query: normalizedQuery
  });

  if (withAttestation) {
    payload.attestation = buildSettlementVaultReconciliationExportAttestation({
      query: normalizedQuery,
      nextCursor: normalizedNextCursor,
      exportHash: payload.export_hash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildSettlementVaultReconciliationExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null,
      nextCursor: normalizedNextCursor,
      entriesCount: Array.isArray(vaultReconciliation?.entries) ? vaultReconciliation.entries.length : 0,
      totalFiltered: normalizedTotalFiltered ?? 0
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });

  return payload;
}

export function verifySettlementVaultReconciliationExportPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildSettlementVaultReconciliationExportHash({
    cycleId: payload.cycle_id,
    timelineState: payload.timeline_state,
    vaultReconciliation: payload.vault_reconciliation,
    stateTransitions: payload.state_transitions,
    totalFiltered: payload.total_filtered,
    nextCursor: payload.next_cursor,
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

  if (payload.attestation) {
    const attest = verifySettlementVaultReconciliationExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attest.ok) return attest;
  }

  if (payload.checkpoint) {
    const checkpoint = verifySettlementVaultReconciliationExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload?.vault_reconciliation?.entries) ? payload.vault_reconciliation.entries.length : 0,
      totalFiltered: payload.total_filtered
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = vaultReconciliationExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifySettlementVaultReconciliationExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing_payload' };
  }

  const expectedHash = buildSettlementVaultReconciliationExportHash({
    cycleId: payload.cycle_id,
    timelineState: payload.timeline_state,
    vaultReconciliation: payload.vault_reconciliation,
    stateTransitions: payload.state_transitions,
    totalFiltered: payload.total_filtered,
    nextCursor: payload.next_cursor,
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

  if (payload.attestation) {
    const attest = verifySettlementVaultReconciliationExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attest.ok) return attest;
  }

  if (payload.checkpoint) {
    const checkpoint = verifySettlementVaultReconciliationExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload?.vault_reconciliation?.entries) ? payload.vault_reconciliation.entries.length : 0,
      totalFiltered: payload.total_filtered
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = vaultReconciliationExportSignablePayload(payload);

  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
    payload: signable,
    publicKeyPem,
    keyId,
    alg
  });
}
