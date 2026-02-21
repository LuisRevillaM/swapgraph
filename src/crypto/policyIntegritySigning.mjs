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

  const continuationWindowMinutes = Number.parseInt(String(query?.continuation_window_minutes ?? ''), 10);
  if (Number.isFinite(continuationWindowMinutes) && continuationWindowMinutes > 0) out.continuation_window_minutes = continuationWindowMinutes;

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
  const executionContinuationAttestationAfter = typeof automationHints?.execution_attestation?.continuation_attestation_after === 'string' && automationHints.execution_attestation.continuation_attestation_after.trim()
    ? automationHints.execution_attestation.continuation_attestation_after.trim()
    : null;
  const executionContinuationCheckpointAfter = typeof automationHints?.execution_attestation?.continuation_checkpoint_after === 'string' && automationHints.execution_attestation.continuation_checkpoint_after.trim()
    ? automationHints.execution_attestation.continuation_checkpoint_after.trim()
    : null;
  const executionContinuationHash = typeof automationHints?.execution_attestation?.continuation_hash === 'string' && automationHints.execution_attestation.continuation_hash.trim()
    ? automationHints.execution_attestation.continuation_hash.trim()
    : null;
  const executionContinuationWindowMinutes = Number.parseInt(String(automationHints?.execution_attestation?.continuation_window_minutes ?? ''), 10);
  const executionContinuationExpiresAt = typeof automationHints?.execution_attestation?.continuation_expires_at === 'string' && automationHints.execution_attestation.continuation_expires_at.trim()
    ? automationHints.execution_attestation.continuation_expires_at.trim()
    : null;
  const executionReceiptStepsCount = Number.parseInt(String(automationHints?.execution_attestation?.receipt_steps_count ?? ''), 10);
  const executionReceiptHash = typeof automationHints?.execution_attestation?.receipt_hash === 'string' && automationHints.execution_attestation.receipt_hash.trim()
    ? automationHints.execution_attestation.receipt_hash.trim()
    : null;
  const executionJournalEntryHashes = Array.isArray(automationHints?.execution_attestation?.journal_entry_hashes)
    ? automationHints.execution_attestation.journal_entry_hashes.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
    : [];
  const executionJournalHash = typeof automationHints?.execution_attestation?.journal_hash === 'string' && automationHints.execution_attestation.journal_hash.trim()
    ? automationHints.execution_attestation.journal_hash.trim()
    : null;
  const executionRollbackTargetPolicyVersion = Number.parseInt(String(automationHints?.execution_attestation?.rollback_target_policy_version ?? ''), 10);
  const executionRollbackHash = typeof automationHints?.execution_attestation?.rollback_hash === 'string' && automationHints.execution_attestation.rollback_hash.trim()
    ? automationHints.execution_attestation.rollback_hash.trim()
    : null;
  const executionSimulationProjectedPolicyVersionAfter = Number.parseInt(String(automationHints?.execution_attestation?.simulation_projected_policy_version_after ?? ''), 10);
  const executionSimulationRiskLevel = typeof automationHints?.execution_attestation?.simulation_risk_level === 'string' && automationHints.execution_attestation.simulation_risk_level.trim()
    ? automationHints.execution_attestation.simulation_risk_level.trim()
    : 'low';
  const executionSimulationHash = typeof automationHints?.execution_attestation?.simulation_hash === 'string' && automationHints.execution_attestation.simulation_hash.trim()
    ? automationHints.execution_attestation.simulation_hash.trim()
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
      attestation_hash: executionAttestationHash,
      continuation_attestation_after: executionContinuationAttestationAfter,
      continuation_checkpoint_after: executionContinuationCheckpointAfter,
      continuation_hash: executionContinuationHash,
      continuation_window_minutes: Number.isFinite(executionContinuationWindowMinutes) && executionContinuationWindowMinutes > 0
        ? executionContinuationWindowMinutes
        : 30,
      continuation_expires_at: executionContinuationExpiresAt,
      receipt_steps_count: Number.isFinite(executionReceiptStepsCount) && executionReceiptStepsCount >= 0
        ? executionReceiptStepsCount
        : 0,
      receipt_hash: executionReceiptHash,
      journal_entry_hashes: executionJournalEntryHashes,
      journal_hash: executionJournalHash,
      rollback_target_policy_version: Number.isFinite(executionRollbackTargetPolicyVersion) && executionRollbackTargetPolicyVersion >= 0
        ? executionRollbackTargetPolicyVersion
        : 0,
      rollback_hash: executionRollbackHash,
      simulation_projected_policy_version_after: Number.isFinite(executionSimulationProjectedPolicyVersionAfter) && executionSimulationProjectedPolicyVersionAfter >= 0
        ? executionSimulationProjectedPolicyVersionAfter
        : 0,
      simulation_risk_level: ['low', 'medium', 'high'].includes(executionSimulationRiskLevel)
        ? executionSimulationRiskLevel
        : 'low',
      simulation_hash: executionSimulationHash
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
    request_hash_chain: executionAttestation?.request_hash_chain ?? null,
    continuation_attestation_after: executionAttestation?.continuation_attestation_after ?? null,
    continuation_checkpoint_after: executionAttestation?.continuation_checkpoint_after ?? null,
    continuation_window_minutes: executionAttestation?.continuation_window_minutes ?? 30,
    continuation_expires_at: executionAttestation?.continuation_expires_at ?? null,
    receipt_steps_count: executionAttestation?.receipt_steps_count ?? 0,
    receipt_hash: executionAttestation?.receipt_hash ?? null,
    journal_entry_hashes: executionAttestation?.journal_entry_hashes ?? [],
    journal_hash: executionAttestation?.journal_hash ?? null,
    rollback_target_policy_version: executionAttestation?.rollback_target_policy_version ?? 0,
    rollback_hash: executionAttestation?.rollback_hash ?? null,
    simulation_projected_policy_version_after: executionAttestation?.simulation_projected_policy_version_after ?? 0,
    simulation_risk_level: executionAttestation?.simulation_risk_level ?? 'low',
    simulation_hash: executionAttestation?.simulation_hash ?? null
  });
}

function buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionContinuationHash({
  continuationAttestationAfter,
  continuationCheckpointAfter,
  continuationWindowMinutes,
  continuationExpiresAt,
  planHash,
  executionAttestationHash
}) {
  return sha256HexCanonical({
    attestation_after: continuationAttestationAfter ?? null,
    checkpoint_after: continuationCheckpointAfter ?? null,
    continuation_window_minutes: continuationWindowMinutes ?? 30,
    continuation_expires_at: continuationExpiresAt ?? null,
    plan_hash: planHash ?? null,
    attestation_hash: executionAttestationHash ?? null
  });
}

function verifyPartnerProgramRolloutPolicyDiagnosticsAutomationHintsConsistency({ policy, query, exportedAt, automationHints }) {
  const normalizedAutomationHints = normalizePartnerProgramRolloutPolicyDiagnosticsAutomationHints(automationHints);
  if (!normalizedAutomationHints) {
    return { ok: true };
  }

  const actionRequests = Array.isArray(normalizedAutomationHints.action_requests)
    ? normalizedAutomationHints.action_requests
    : [];
  const normalizedQuery = normalizePartnerProgramRolloutPolicyDiagnosticsExportQuery(query);

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

  const expectedContinuationAttestationAfter = typeof normalizedQuery.attestation_after === 'string'
    ? normalizedQuery.attestation_after
    : null;
  const expectedContinuationCheckpointAfter = typeof normalizedQuery.checkpoint_after === 'string'
    ? normalizedQuery.checkpoint_after
    : null;

  if (normalizedAutomationHints.execution_attestation.continuation_attestation_after !== expectedContinuationAttestationAfter) {
    return {
      ok: false,
      error: 'automation_execution_continuation_attestation_after_mismatch',
      details: {
        expected_continuation_attestation_after: expectedContinuationAttestationAfter,
        provided_continuation_attestation_after: normalizedAutomationHints.execution_attestation.continuation_attestation_after
      }
    };
  }

  if (normalizedAutomationHints.execution_attestation.continuation_checkpoint_after !== expectedContinuationCheckpointAfter) {
    return {
      ok: false,
      error: 'automation_execution_continuation_checkpoint_after_mismatch',
      details: {
        expected_continuation_checkpoint_after: expectedContinuationCheckpointAfter,
        provided_continuation_checkpoint_after: normalizedAutomationHints.execution_attestation.continuation_checkpoint_after
      }
    };
  }

  const expectedContinuationWindowMinutes = Number.isFinite(normalizedQuery.continuation_window_minutes)
    ? Number(normalizedQuery.continuation_window_minutes)
    : 30;
  if (normalizedAutomationHints.execution_attestation.continuation_window_minutes !== expectedContinuationWindowMinutes) {
    return {
      ok: false,
      error: 'automation_execution_continuation_window_minutes_mismatch',
      details: {
        expected_continuation_window_minutes: expectedContinuationWindowMinutes,
        provided_continuation_window_minutes: normalizedAutomationHints.execution_attestation.continuation_window_minutes
      }
    };
  }

  const exportedAtMs = parseIso(exportedAt);
  const expectedContinuationExpiresAt = exportedAtMs === null
    ? null
    : new Date(exportedAtMs + (expectedContinuationWindowMinutes * 60000)).toISOString();
  if (normalizedAutomationHints.execution_attestation.continuation_expires_at !== expectedContinuationExpiresAt) {
    return {
      ok: false,
      error: 'automation_execution_continuation_expires_at_mismatch',
      details: {
        expected_continuation_expires_at: expectedContinuationExpiresAt,
        provided_continuation_expires_at: normalizedAutomationHints.execution_attestation.continuation_expires_at
      }
    };
  }

  const expectedReceiptStepsCount = actionRequests.length;
  if (normalizedAutomationHints.execution_attestation.receipt_steps_count !== expectedReceiptStepsCount) {
    return {
      ok: false,
      error: 'automation_execution_receipt_steps_count_mismatch',
      details: {
        expected_receipt_steps_count: expectedReceiptStepsCount,
        provided_receipt_steps_count: normalizedAutomationHints.execution_attestation.receipt_steps_count
      }
    };
  }

  const expectedReceiptHash = sha256HexCanonical({
    plan_hash: normalizedAutomationHints.plan_hash,
    request_hash_chain: normalizedAutomationHints.execution_attestation.request_hash_chain,
    steps_count: expectedReceiptStepsCount,
    policy_version_before: expectedPolicyVersionBefore,
    policy_version_after_expected: expectedPolicyVersionAfterExpected
  });
  if (normalizedAutomationHints.execution_attestation.receipt_hash !== expectedReceiptHash) {
    return {
      ok: false,
      error: 'automation_execution_receipt_hash_mismatch',
      details: {
        expected_receipt_hash: expectedReceiptHash,
        provided_receipt_hash: normalizedAutomationHints.execution_attestation.receipt_hash
      }
    };
  }

  const expectedJournalEntryHashes = actionRequests.map(request => sha256HexCanonical({
    step: request?.step ?? null,
    request_hash: request?.request_hash ?? null,
    expected_effect: request?.expected_effect ?? null
  }));
  if (JSON.stringify(normalizedAutomationHints.execution_attestation.journal_entry_hashes ?? []) !== JSON.stringify(expectedJournalEntryHashes)) {
    return {
      ok: false,
      error: 'automation_execution_journal_entry_hashes_mismatch',
      details: {
        expected_journal_entry_hashes: expectedJournalEntryHashes,
        provided_journal_entry_hashes: normalizedAutomationHints.execution_attestation.journal_entry_hashes ?? []
      }
    };
  }

  const expectedJournalHash = sha256HexCanonical({ entry_hashes: expectedJournalEntryHashes });
  if (normalizedAutomationHints.execution_attestation.journal_hash !== expectedJournalHash) {
    return {
      ok: false,
      error: 'automation_execution_journal_hash_mismatch',
      details: {
        expected_journal_hash: expectedJournalHash,
        provided_journal_hash: normalizedAutomationHints.execution_attestation.journal_hash
      }
    };
  }

  const expectedRollbackTargetPolicyVersion = expectedPolicyVersionBefore;
  if (normalizedAutomationHints.execution_attestation.rollback_target_policy_version !== expectedRollbackTargetPolicyVersion) {
    return {
      ok: false,
      error: 'automation_execution_rollback_target_policy_version_mismatch',
      details: {
        expected_rollback_target_policy_version: expectedRollbackTargetPolicyVersion,
        provided_rollback_target_policy_version: normalizedAutomationHints.execution_attestation.rollback_target_policy_version
      }
    };
  }

  const expectedRollbackHash = sha256HexCanonical({
    rollback_target_policy_version: expectedRollbackTargetPolicyVersion,
    policy_version_after_expected: expectedPolicyVersionAfterExpected,
    non_empty_action_plan: expectedNonEmptyActionPlan
  });
  if (normalizedAutomationHints.execution_attestation.rollback_hash !== expectedRollbackHash) {
    return {
      ok: false,
      error: 'automation_execution_rollback_hash_mismatch',
      details: {
        expected_rollback_hash: expectedRollbackHash,
        provided_rollback_hash: normalizedAutomationHints.execution_attestation.rollback_hash
      }
    };
  }

  const expectedSimulationProjectedPolicyVersionAfter = expectedPolicyVersionAfterExpected;
  if (normalizedAutomationHints.execution_attestation.simulation_projected_policy_version_after !== expectedSimulationProjectedPolicyVersionAfter) {
    return {
      ok: false,
      error: 'automation_execution_simulation_projected_policy_version_after_mismatch',
      details: {
        expected_simulation_projected_policy_version_after: expectedSimulationProjectedPolicyVersionAfter,
        provided_simulation_projected_policy_version_after: normalizedAutomationHints.execution_attestation.simulation_projected_policy_version_after
      }
    };
  }

  const expectedSimulationRiskLevel = actionRequests.length === 0
    ? 'low'
    : (actionRequests.length === 1 ? 'medium' : 'high');
  if (normalizedAutomationHints.execution_attestation.simulation_risk_level !== expectedSimulationRiskLevel) {
    return {
      ok: false,
      error: 'automation_execution_simulation_risk_level_mismatch',
      details: {
        expected_simulation_risk_level: expectedSimulationRiskLevel,
        provided_simulation_risk_level: normalizedAutomationHints.execution_attestation.simulation_risk_level
      }
    };
  }

  const expectedSimulationHash = sha256HexCanonical({
    projected_policy_version_after: expectedSimulationProjectedPolicyVersionAfter,
    risk_level: expectedSimulationRiskLevel,
    expected_effect_hash: expectedEffectHash
  });
  if (normalizedAutomationHints.execution_attestation.simulation_hash !== expectedSimulationHash) {
    return {
      ok: false,
      error: 'automation_execution_simulation_hash_mismatch',
      details: {
        expected_simulation_hash: expectedSimulationHash,
        provided_simulation_hash: normalizedAutomationHints.execution_attestation.simulation_hash
      }
    };
  }

  const expectedContinuationHash = buildPartnerProgramRolloutPolicyDiagnosticsAutomationExecutionContinuationHash({
    continuationAttestationAfter: expectedContinuationAttestationAfter,
    continuationCheckpointAfter: expectedContinuationCheckpointAfter,
    continuationWindowMinutes: expectedContinuationWindowMinutes,
    continuationExpiresAt: expectedContinuationExpiresAt,
    planHash: normalizedAutomationHints.plan_hash,
    executionAttestationHash: normalizedAutomationHints.execution_attestation.attestation_hash
  });

  if (normalizedAutomationHints.execution_attestation.continuation_hash !== expectedContinuationHash) {
    return {
      ok: false,
      error: 'automation_execution_continuation_hash_mismatch',
      details: {
        expected_continuation_hash: expectedContinuationHash,
        provided_continuation_hash: normalizedAutomationHints.execution_attestation.continuation_hash
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
    query: payload.query,
    exportedAt: payload.exported_at,
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
    query: payload.query,
    exportedAt: payload.exported_at,
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

function normalizePartnerProgramCommercialUsageExportQuery(query) {
  const out = {};

  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.feature_code === 'string' && query.feature_code.trim()) out.feature_code = query.feature_code.trim();
  if (typeof query?.unit_type === 'string' && query.unit_type.trim()) out.unit_type = query.unit_type.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizePartnerProgramCommercialUsageLedgerSummary(summary) {
  const breakdown = Array.isArray(summary?.feature_breakdown)
    ? summary.feature_breakdown
      .map(item => ({
        feature_code: typeof item?.feature_code === 'string' ? item.feature_code : null,
        unit_type: typeof item?.unit_type === 'string' ? item.unit_type : null,
        units: Number.isFinite(item?.units) ? Number(item.units) : 0,
        amount_usd_micros: Number.isFinite(item?.amount_usd_micros) ? Number(item.amount_usd_micros) : 0
      }))
      .sort((a, b) => `${a.feature_code}|${a.unit_type}`.localeCompare(`${b.feature_code}|${b.unit_type}`))
    : [];

  return {
    partner_id: typeof summary?.partner_id === 'string' && summary.partner_id.trim() ? summary.partner_id.trim() : null,
    entries_count: Number.isFinite(summary?.entries_count) ? Number(summary.entries_count) : 0,
    total_units: Number.isFinite(summary?.total_units) ? Number(summary.total_units) : 0,
    total_amount_usd_micros: Number.isFinite(summary?.total_amount_usd_micros) ? Number(summary.total_amount_usd_micros) : 0,
    feature_breakdown: breakdown
  };
}

function normalizePartnerProgramCommercialUsageEntry(entry) {
  return {
    entry_id: typeof entry?.entry_id === 'string' ? entry.entry_id : null,
    partner_id: typeof entry?.partner_id === 'string' ? entry.partner_id : null,
    feature_code: typeof entry?.feature_code === 'string' ? entry.feature_code : null,
    unit_type: typeof entry?.unit_type === 'string' ? entry.unit_type : null,
    units: Number.isFinite(entry?.units) ? Number(entry.units) : 0,
    unit_price_usd_micros: Number.isFinite(entry?.unit_price_usd_micros) ? Number(entry.unit_price_usd_micros) : 0,
    amount_usd_micros: Number.isFinite(entry?.amount_usd_micros) ? Number(entry.amount_usd_micros) : 0,
    occurred_at: typeof entry?.occurred_at === 'string' ? entry.occurred_at : null,
    metadata: entry?.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata : {}
  };
}

function normalizePartnerProgramCommercialUsageEntries(entries) {
  return (entries ?? [])
    .map(normalizePartnerProgramCommercialUsageEntry)
    .sort((a, b) => {
      const aKey = `${a.occurred_at ?? ''}|${a.entry_id ?? ''}`;
      const bKey = `${b.occurred_at ?? ''}|${b.entry_id ?? ''}`;
      return aKey.localeCompare(bKey);
    });
}

function partnerProgramCommercialUsageExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramCommercialUsageExportQuery(payload?.query),
    ledger_summary: normalizePartnerProgramCommercialUsageLedgerSummary(payload?.ledger_summary),
    entries: normalizePartnerProgramCommercialUsageEntries(payload?.entries),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildPartnerProgramCommercialUsageExportHash({ query, ledgerSummary, entries }) {
  return sha256HexCanonical({
    query: normalizePartnerProgramCommercialUsageExportQuery(query),
    ledger_summary: normalizePartnerProgramCommercialUsageLedgerSummary(ledgerSummary),
    entries: normalizePartnerProgramCommercialUsageEntries(entries)
  });
}

export function buildSignedPartnerProgramCommercialUsageExportPayload({ exportedAt, query, ledgerSummary, entries, keyId }) {
  const normalizedQuery = normalizePartnerProgramCommercialUsageExportQuery(query);
  const normalizedLedgerSummary = normalizePartnerProgramCommercialUsageLedgerSummary(ledgerSummary);
  const normalizedEntries = normalizePartnerProgramCommercialUsageEntries(entries);

  const exportHash = buildPartnerProgramCommercialUsageExportHash({
    query: normalizedQuery,
    ledgerSummary: normalizedLedgerSummary,
    entries: normalizedEntries
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    ledger_summary: normalizedLedgerSummary,
    entries: normalizedEntries,
    export_hash: exportHash
  };

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramCommercialUsageExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramCommercialUsageExportHash({
    query: payload.query,
    ledgerSummary: payload.ledger_summary,
    entries: payload.entries
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

  const signable = partnerProgramCommercialUsageExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramCommercialUsageExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramCommercialUsageExportHash({
    query: payload.query,
    ledgerSummary: payload.ledger_summary,
    entries: payload.entries
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

  const signable = partnerProgramCommercialUsageExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizePartnerProgramBillingStatementExportQuery(query) {
  const out = {};

  if (typeof query?.period_start_iso === 'string' && query.period_start_iso.trim()) out.period_start_iso = query.period_start_iso.trim();
  if (typeof query?.period_end_iso === 'string' && query.period_end_iso.trim()) out.period_end_iso = query.period_end_iso.trim();
  if (Number.isFinite(query?.rev_share_partner_bps)) out.rev_share_partner_bps = Number(query.rev_share_partner_bps);
  else {
    const bps = Number.parseInt(String(query?.rev_share_partner_bps ?? ''), 10);
    if (Number.isFinite(bps)) out.rev_share_partner_bps = bps;
  }
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizePartnerProgramBillingStatement(statement) {
  const lines = Array.isArray(statement?.lines)
    ? statement.lines
      .map(line => ({
        line_id: typeof line?.line_id === 'string' ? line.line_id : null,
        feature_code: typeof line?.feature_code === 'string' ? line.feature_code : null,
        unit_type: typeof line?.unit_type === 'string' ? line.unit_type : null,
        unit_price_usd_micros: Number.isFinite(line?.unit_price_usd_micros) ? Number(line.unit_price_usd_micros) : 0,
        units: Number.isFinite(line?.units) ? Number(line.units) : 0,
        amount_usd_micros: Number.isFinite(line?.amount_usd_micros) ? Number(line.amount_usd_micros) : 0
      }))
      .sort((a, b) => String(a.line_id ?? '').localeCompare(String(b.line_id ?? '')))
    : [];

  return {
    statement_id: typeof statement?.statement_id === 'string' ? statement.statement_id : null,
    partner_id: typeof statement?.partner_id === 'string' ? statement.partner_id : null,
    period_start: typeof statement?.period_start === 'string' ? statement.period_start : null,
    period_end: typeof statement?.period_end === 'string' ? statement.period_end : null,
    rev_share_partner_bps: Number.isFinite(statement?.rev_share_partner_bps) ? Number(statement.rev_share_partner_bps) : 0,
    lines,
    totals: {
      gross_amount_usd_micros: Number.isFinite(statement?.totals?.gross_amount_usd_micros) ? Number(statement.totals.gross_amount_usd_micros) : 0,
      partner_share_usd_micros: Number.isFinite(statement?.totals?.partner_share_usd_micros) ? Number(statement.totals.partner_share_usd_micros) : 0,
      platform_share_usd_micros: Number.isFinite(statement?.totals?.platform_share_usd_micros) ? Number(statement.totals.platform_share_usd_micros) : 0
    }
  };
}

function partnerProgramBillingStatementExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramBillingStatementExportQuery(payload?.query),
    statement: normalizePartnerProgramBillingStatement(payload?.statement),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildPartnerProgramBillingStatementExportHash({ query, statement }) {
  return sha256HexCanonical({
    query: normalizePartnerProgramBillingStatementExportQuery(query),
    statement: normalizePartnerProgramBillingStatement(statement)
  });
}

export function buildSignedPartnerProgramBillingStatementExportPayload({ exportedAt, query, statement, keyId }) {
  const normalizedQuery = normalizePartnerProgramBillingStatementExportQuery(query);
  const normalizedStatement = normalizePartnerProgramBillingStatement(statement);

  const exportHash = buildPartnerProgramBillingStatementExportHash({
    query: normalizedQuery,
    statement: normalizedStatement
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    statement: normalizedStatement,
    export_hash: exportHash
  };

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramBillingStatementExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramBillingStatementExportHash({
    query: payload.query,
    statement: payload.statement
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

  const signable = partnerProgramBillingStatementExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramBillingStatementExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramBillingStatementExportHash({
    query: payload.query,
    statement: payload.statement
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

  const signable = partnerProgramBillingStatementExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizePartnerProgramSlaBreachExportQuery(query) {
  const out = {};

  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.include_resolved === 'boolean') out.include_resolved = query.include_resolved;
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizePartnerProgramSlaPolicyForExport(policy) {
  if (!policy || typeof policy !== 'object') return null;

  return {
    partner_id: typeof policy?.partner_id === 'string' ? policy.partner_id : null,
    version: Number.isFinite(policy?.version) ? Number(policy.version) : null,
    updated_at: typeof policy?.updated_at === 'string' ? policy.updated_at : null,
    latency_p95_ms: Number.isFinite(policy?.latency_p95_ms) ? Number(policy.latency_p95_ms) : null,
    availability_target_bps: Number.isFinite(policy?.availability_target_bps) ? Number(policy.availability_target_bps) : null,
    dispute_response_minutes: Number.isFinite(policy?.dispute_response_minutes) ? Number(policy.dispute_response_minutes) : null,
    breach_threshold_minutes: Number.isFinite(policy?.breach_threshold_minutes) ? Number(policy.breach_threshold_minutes) : null
  };
}

function normalizePartnerProgramSlaBreachSummary(summary) {
  return {
    total_events: Number.isFinite(summary?.total_events) ? Number(summary.total_events) : 0,
    open_events: Number.isFinite(summary?.open_events) ? Number(summary.open_events) : 0,
    high_severity_events: Number.isFinite(summary?.high_severity_events) ? Number(summary.high_severity_events) : 0
  };
}

function normalizePartnerProgramSlaBreachEvents(events) {
  return (events ?? [])
    .map(event => ({
      event_id: typeof event?.event_id === 'string' ? event.event_id : null,
      partner_id: typeof event?.partner_id === 'string' ? event.partner_id : null,
      event_type: typeof event?.event_type === 'string' ? event.event_type : null,
      severity: typeof event?.severity === 'string' ? event.severity : null,
      reason_code: typeof event?.reason_code === 'string' ? event.reason_code : null,
      occurred_at: typeof event?.occurred_at === 'string' ? event.occurred_at : null,
      resolved: event?.resolved === true,
      resolved_at: typeof event?.resolved_at === 'string' ? event.resolved_at : null,
      metadata: event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? event.metadata : {}
    }))
    .sort((a, b) => `${a.occurred_at ?? ''}|${a.event_id ?? ''}`.localeCompare(`${b.occurred_at ?? ''}|${b.event_id ?? ''}`));
}

function partnerProgramSlaBreachExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramSlaBreachExportQuery(payload?.query),
    policy: normalizePartnerProgramSlaPolicyForExport(payload?.policy),
    summary: normalizePartnerProgramSlaBreachSummary(payload?.summary),
    events: normalizePartnerProgramSlaBreachEvents(payload?.events),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildPartnerProgramSlaBreachExportHash({ query, policy, summary, events }) {
  return sha256HexCanonical({
    query: normalizePartnerProgramSlaBreachExportQuery(query),
    policy: normalizePartnerProgramSlaPolicyForExport(policy),
    summary: normalizePartnerProgramSlaBreachSummary(summary),
    events: normalizePartnerProgramSlaBreachEvents(events)
  });
}

export function buildSignedPartnerProgramSlaBreachExportPayload({ exportedAt, query, policy, summary, events, keyId }) {
  const normalizedQuery = normalizePartnerProgramSlaBreachExportQuery(query);
  const normalizedPolicy = normalizePartnerProgramSlaPolicyForExport(policy);
  const normalizedSummary = normalizePartnerProgramSlaBreachSummary(summary);
  const normalizedEvents = normalizePartnerProgramSlaBreachEvents(events);

  const exportHash = buildPartnerProgramSlaBreachExportHash({
    query: normalizedQuery,
    policy: normalizedPolicy,
    summary: normalizedSummary,
    events: normalizedEvents
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    policy: normalizedPolicy,
    summary: normalizedSummary,
    events: normalizedEvents,
    export_hash: exportHash
  };

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramSlaBreachExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramSlaBreachExportHash({
    query: payload.query,
    policy: payload.policy,
    summary: payload.summary,
    events: payload.events
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

  const signable = partnerProgramSlaBreachExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramSlaBreachExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramSlaBreachExportHash({
    query: payload.query,
    policy: payload.policy,
    summary: payload.summary,
    events: payload.events
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

  const signable = partnerProgramSlaBreachExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizePartnerProgramWebhookDeadLetterExportQuery(query) {
  const out = {};

  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.include_replayed === 'boolean') out.include_replayed = query.include_replayed;

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizePartnerProgramWebhookDeadLetterExportSummary(summary) {
  return {
    total_attempts: Number.isFinite(summary?.total_attempts) ? Number(summary.total_attempts) : 0,
    deliveries_count: Number.isFinite(summary?.deliveries_count) ? Number(summary.deliveries_count) : 0,
    dead_letter_count: Number.isFinite(summary?.dead_letter_count) ? Number(summary.dead_letter_count) : 0,
    pending_retry_count: Number.isFinite(summary?.pending_retry_count) ? Number(summary.pending_retry_count) : 0,
    replayed_count: Number.isFinite(summary?.replayed_count) ? Number(summary.replayed_count) : 0,
    returned_count: Number.isFinite(summary?.returned_count) ? Number(summary.returned_count) : 0
  };
}

function normalizePartnerProgramWebhookRetryPolicy(policy) {
  return {
    max_attempts: Number.isFinite(policy?.max_attempts) ? Number(policy.max_attempts) : 0,
    backoff_seconds: Number.isFinite(policy?.backoff_seconds) ? Number(policy.backoff_seconds) : 0
  };
}

function normalizePartnerProgramWebhookDeadLetterEntry(entry) {
  return {
    delivery_id: typeof entry?.delivery_id === 'string' ? entry.delivery_id : null,
    partner_id: typeof entry?.partner_id === 'string' ? entry.partner_id : null,
    event_type: typeof entry?.event_type === 'string' ? entry.event_type : null,
    endpoint: typeof entry?.endpoint === 'string' ? entry.endpoint : null,
    attempt_count: Number.isFinite(entry?.attempt_count) ? Number(entry.attempt_count) : 0,
    max_attempts: Number.isFinite(entry?.max_attempts) ? Number(entry.max_attempts) : 0,
    first_attempt_at: typeof entry?.first_attempt_at === 'string' ? entry.first_attempt_at : null,
    last_attempt_at: typeof entry?.last_attempt_at === 'string' ? entry.last_attempt_at : null,
    next_retry_at: typeof entry?.next_retry_at === 'string' ? entry.next_retry_at : null,
    last_error_code: typeof entry?.last_error_code === 'string' ? entry.last_error_code : null,
    last_status: typeof entry?.last_status === 'string' ? entry.last_status : null,
    dead_lettered: entry?.dead_lettered === true,
    dead_lettered_at: typeof entry?.dead_lettered_at === 'string' ? entry.dead_lettered_at : null,
    replayed: entry?.replayed === true,
    replayed_at: typeof entry?.replayed_at === 'string' ? entry.replayed_at : null,
    retry_policy: normalizePartnerProgramWebhookRetryPolicy(entry?.retry_policy),
    metadata: entry?.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata : {}
  };
}

function normalizePartnerProgramWebhookDeadLetterEntries(entries) {
  return (entries ?? [])
    .map(normalizePartnerProgramWebhookDeadLetterEntry)
    .sort((a, b) => `${a.dead_lettered_at ?? ''}|${a.delivery_id ?? ''}`.localeCompare(`${b.dead_lettered_at ?? ''}|${b.delivery_id ?? ''}`));
}

function partnerProgramWebhookDeadLetterExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramWebhookDeadLetterExportQuery(payload?.query),
    summary: normalizePartnerProgramWebhookDeadLetterExportSummary(payload?.summary),
    entries: normalizePartnerProgramWebhookDeadLetterEntries(payload?.entries),
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildPartnerProgramWebhookDeadLetterExportHash({ query, summary, entries, nextCursor }) {
  return sha256HexCanonical({
    query: normalizePartnerProgramWebhookDeadLetterExportQuery(query),
    summary: normalizePartnerProgramWebhookDeadLetterExportSummary(summary),
    entries: normalizePartnerProgramWebhookDeadLetterEntries(entries),
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedPartnerProgramWebhookDeadLetterExportPayload({ exportedAt, query, summary, entries, nextCursor, keyId }) {
  const normalizedQuery = normalizePartnerProgramWebhookDeadLetterExportQuery(query);
  const normalizedSummary = normalizePartnerProgramWebhookDeadLetterExportSummary(summary);
  const normalizedEntries = normalizePartnerProgramWebhookDeadLetterEntries(entries);

  const exportHash = buildPartnerProgramWebhookDeadLetterExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    entries: normalizedEntries,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    entries: normalizedEntries,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramWebhookDeadLetterExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramWebhookDeadLetterExportHash({
    query: payload.query,
    summary: payload.summary,
    entries: payload.entries,
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

  const signable = partnerProgramWebhookDeadLetterExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramWebhookDeadLetterExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramWebhookDeadLetterExportHash({
    query: payload.query,
    summary: payload.summary,
    entries: payload.entries,
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

  const signable = partnerProgramWebhookDeadLetterExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizePartnerProgramDisputeEvidenceBundleExportQuery(query) {
  const out = {};

  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();
  if (typeof query?.include_resolved === 'boolean') out.include_resolved = query.include_resolved;

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizePartnerProgramDisputeEvidenceBundleExportSummary(summary) {
  return {
    total_disputes: Number.isFinite(summary?.total_disputes) ? Number(summary.total_disputes) : 0,
    open_disputes: Number.isFinite(summary?.open_disputes) ? Number(summary.open_disputes) : 0,
    resolved_disputes: Number.isFinite(summary?.resolved_disputes) ? Number(summary.resolved_disputes) : 0,
    total_evidence_items: Number.isFinite(summary?.total_evidence_items) ? Number(summary.total_evidence_items) : 0,
    returned_count: Number.isFinite(summary?.returned_count) ? Number(summary.returned_count) : 0
  };
}

function normalizePartnerProgramDisputeEvidenceItems(items) {
  return (items ?? [])
    .map(item => ({
      evidence_id: typeof item?.evidence_id === 'string' ? item.evidence_id : null,
      kind: typeof item?.kind === 'string' ? item.kind : null,
      content_hash: typeof item?.content_hash === 'string' ? item.content_hash : null,
      metadata: item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {}
    }))
    .sort((a, b) => String(a.evidence_id ?? '').localeCompare(String(b.evidence_id ?? '')));
}

function normalizePartnerProgramDisputeResolution(resolution) {
  if (!resolution || typeof resolution !== 'object') return null;

  const code = typeof resolution?.code === 'string' && resolution.code.trim() ? resolution.code.trim() : null;
  const notes = typeof resolution?.notes === 'string' && resolution.notes.trim() ? resolution.notes.trim() : null;
  if (!code) return null;

  return {
    code,
    ...(notes ? { notes } : {})
  };
}

function normalizePartnerProgramDisputeEvidenceBundle(bundle) {
  return {
    evidence_bundle_id: typeof bundle?.evidence_bundle_id === 'string' ? bundle.evidence_bundle_id : null,
    dispute_id: typeof bundle?.dispute_id === 'string' ? bundle.dispute_id : null,
    partner_id: typeof bundle?.partner_id === 'string' ? bundle.partner_id : null,
    dispute_type: typeof bundle?.dispute_type === 'string' ? bundle.dispute_type : null,
    severity: typeof bundle?.severity === 'string' ? bundle.severity : null,
    subject_ref: typeof bundle?.subject_ref === 'string' ? bundle.subject_ref : null,
    reason_code: typeof bundle?.reason_code === 'string' ? bundle.reason_code : null,
    status: typeof bundle?.status === 'string' ? bundle.status : null,
    opened_at: typeof bundle?.opened_at === 'string' ? bundle.opened_at : null,
    resolved_at: typeof bundle?.resolved_at === 'string' ? bundle.resolved_at : null,
    resolution: normalizePartnerProgramDisputeResolution(bundle?.resolution),
    evidence_items: normalizePartnerProgramDisputeEvidenceItems(bundle?.evidence_items)
  };
}

function normalizePartnerProgramDisputeEvidenceBundles(bundles) {
  return (bundles ?? [])
    .map(normalizePartnerProgramDisputeEvidenceBundle)
    .sort((a, b) => `${a.opened_at ?? ''}|${a.dispute_id ?? ''}`.localeCompare(`${b.opened_at ?? ''}|${b.dispute_id ?? ''}`));
}

function partnerProgramDisputeEvidenceBundleExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizePartnerProgramDisputeEvidenceBundleExportQuery(payload?.query),
    summary: normalizePartnerProgramDisputeEvidenceBundleExportSummary(payload?.summary),
    bundles: normalizePartnerProgramDisputeEvidenceBundles(payload?.bundles),
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildPartnerProgramDisputeEvidenceBundleExportHash({ query, summary, bundles, nextCursor }) {
  return sha256HexCanonical({
    query: normalizePartnerProgramDisputeEvidenceBundleExportQuery(query),
    summary: normalizePartnerProgramDisputeEvidenceBundleExportSummary(summary),
    bundles: normalizePartnerProgramDisputeEvidenceBundles(bundles),
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedPartnerProgramDisputeEvidenceBundleExportPayload({ exportedAt, query, summary, bundles, nextCursor, keyId }) {
  const normalizedQuery = normalizePartnerProgramDisputeEvidenceBundleExportQuery(query);
  const normalizedSummary = normalizePartnerProgramDisputeEvidenceBundleExportSummary(summary);
  const normalizedBundles = normalizePartnerProgramDisputeEvidenceBundles(bundles);

  const exportHash = buildPartnerProgramDisputeEvidenceBundleExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    bundles: normalizedBundles,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    bundles: normalizedBundles,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyPartnerProgramDisputeEvidenceBundleExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramDisputeEvidenceBundleExportHash({
    query: payload.query,
    summary: payload.summary,
    bundles: payload.bundles,
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

  const signable = partnerProgramDisputeEvidenceBundleExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyPartnerProgramDisputeEvidenceBundleExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildPartnerProgramDisputeEvidenceBundleExportHash({
    query: payload.query,
    summary: payload.summary,
    bundles: payload.bundles,
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

  const signable = partnerProgramDisputeEvidenceBundleExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizeTransparencyLogPublicationExportQuery(query) {
  const out = {};

  if (typeof query?.source_type === 'string' && query.source_type.trim()) out.source_type = query.source_type.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizeTransparencyLogPublicationExportSummary(summary) {
  return {
    total_publications: Number.isFinite(summary?.total_publications) ? Number(summary.total_publications) : 0,
    returned_count: Number.isFinite(summary?.returned_count) ? Number(summary.returned_count) : 0,
    total_entries: Number.isFinite(summary?.total_entries) ? Number(summary.total_entries) : 0,
    chain_head: typeof summary?.chain_head === 'string' ? summary.chain_head : null,
    chain_tail: typeof summary?.chain_tail === 'string' ? summary.chain_tail : null
  };
}

function normalizeTransparencyLogPublicationRecord(publication) {
  return {
    publication_id: typeof publication?.publication_id === 'string' ? publication.publication_id : null,
    publication_index: Number.isFinite(publication?.publication_index) ? Number(publication.publication_index) : 0,
    partner_id: typeof publication?.partner_id === 'string' ? publication.partner_id : null,
    source_type: typeof publication?.source_type === 'string' ? publication.source_type : null,
    source_ref: typeof publication?.source_ref === 'string' ? publication.source_ref : null,
    root_hash: typeof publication?.root_hash === 'string' ? publication.root_hash : null,
    previous_root_hash: typeof publication?.previous_root_hash === 'string' ? publication.previous_root_hash : null,
    previous_chain_hash: typeof publication?.previous_chain_hash === 'string' ? publication.previous_chain_hash : null,
    chain_hash: typeof publication?.chain_hash === 'string' ? publication.chain_hash : null,
    entry_count: Number.isFinite(publication?.entry_count) ? Number(publication.entry_count) : 0,
    artifact_refs: (publication?.artifact_refs ?? [])
      .filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim())
      .sort(),
    linked_receipt_ids: (publication?.linked_receipt_ids ?? [])
      .filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim())
      .sort(),
    linked_governance_artifact_ids: (publication?.linked_governance_artifact_ids ?? [])
      .filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim())
      .sort(),
    ...(typeof publication?.notes === 'string' ? { notes: publication.notes } : {}),
    integration_mode: typeof publication?.integration_mode === 'string' ? publication.integration_mode : 'fixture_only',
    published_at: typeof publication?.published_at === 'string' ? publication.published_at : null
  };
}

function normalizeTransparencyLogPublicationRecords(publications) {
  return (publications ?? [])
    .map(normalizeTransparencyLogPublicationRecord)
    .sort((a, b) => `${a.published_at ?? ''}|${a.publication_id ?? ''}`.localeCompare(`${b.published_at ?? ''}|${b.publication_id ?? ''}`));
}

function transparencyLogPublicationExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeTransparencyLogPublicationExportQuery(payload?.query),
    summary: normalizeTransparencyLogPublicationExportSummary(payload?.summary),
    publications: normalizeTransparencyLogPublicationRecords(payload?.publications),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    ...(payload?.attestation ? { attestation: normalizeExportAttestation(payload.attestation) } : {}),
    ...(payload?.checkpoint ? { checkpoint: normalizeExportCheckpoint(payload.checkpoint) } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildTransparencyLogPublicationExportHash({ query, summary, publications, totalFiltered, nextCursor }) {
  return sha256HexCanonical({
    query: normalizeTransparencyLogPublicationExportQuery(query),
    summary: normalizeTransparencyLogPublicationExportSummary(summary),
    publications: normalizeTransparencyLogPublicationRecords(publications),
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedTransparencyLogPublicationExportPayload({
  exportedAt,
  query,
  summary,
  publications,
  totalFiltered,
  nextCursor,
  withAttestation,
  withCheckpoint,
  keyId
}) {
  const normalizedQuery = normalizeTransparencyLogPublicationExportQuery(query);
  const normalizedSummary = normalizeTransparencyLogPublicationExportSummary(summary);
  const normalizedPublications = normalizeTransparencyLogPublicationRecords(publications);
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0;

  const exportHash = buildTransparencyLogPublicationExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    publications: normalizedPublications,
    totalFiltered: normalizedTotalFiltered,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    publications: normalizedPublications,
    total_filtered: normalizedTotalFiltered,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor,
      exportHash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildPolicyAuditExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null,
      nextCursor,
      entriesCount: normalizedPublications.length,
      totalFiltered: normalizedTotalFiltered
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyTransparencyLogPublicationExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildTransparencyLogPublicationExportHash({
    query: payload.query,
    summary: payload.summary,
    publications: payload.publications,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.publications) ? payload.publications.length : 0,
      totalFiltered: Number.isFinite(payload.total_filtered) ? Number(payload.total_filtered) : 0
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = transparencyLogPublicationExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyTransparencyLogPublicationExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildTransparencyLogPublicationExportHash({
    query: payload.query,
    summary: payload.summary,
    publications: payload.publications,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.publications) ? payload.publications.length : 0,
      totalFiltered: Number.isFinite(payload.total_filtered) ? Number(payload.total_filtered) : 0
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = transparencyLogPublicationExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizeInclusionProofLinkageExportQuery(query) {
  const out = {};

  if (typeof query?.cycle_id === 'string' && query.cycle_id.trim()) out.cycle_id = query.cycle_id.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizeInclusionProofLinkageExportSummary(summary) {
  return {
    total_linkages: Number.isFinite(summary?.total_linkages) ? Number(summary.total_linkages) : 0,
    returned_count: Number.isFinite(summary?.returned_count) ? Number(summary.returned_count) : 0,
    linked_receipt_count: Number.isFinite(summary?.linked_receipt_count) ? Number(summary.linked_receipt_count) : 0,
    chain_head: typeof summary?.chain_head === 'string' ? summary.chain_head : null,
    chain_tail: typeof summary?.chain_tail === 'string' ? summary.chain_tail : null
  };
}

function normalizeInclusionProofLinkageRecord(linkage) {
  return {
    linkage_id: typeof linkage?.linkage_id === 'string' ? linkage.linkage_id : null,
    linkage_index: Number.isFinite(linkage?.linkage_index) ? Number(linkage.linkage_index) : 0,
    partner_id: typeof linkage?.partner_id === 'string' ? linkage.partner_id : null,
    cycle_id: typeof linkage?.cycle_id === 'string' ? linkage.cycle_id : null,
    receipt_id: typeof linkage?.receipt_id === 'string' ? linkage.receipt_id : null,
    receipt_hash: typeof linkage?.receipt_hash === 'string' ? linkage.receipt_hash : null,
    receipt_signature_key_id: typeof linkage?.receipt_signature_key_id === 'string' ? linkage.receipt_signature_key_id : null,
    custody_snapshot_id: typeof linkage?.custody_snapshot_id === 'string' ? linkage.custody_snapshot_id : null,
    custody_holding_id: typeof linkage?.custody_holding_id === 'string' ? linkage.custody_holding_id : null,
    custody_root_hash: typeof linkage?.custody_root_hash === 'string' ? linkage.custody_root_hash : null,
    custody_leaf_hash: typeof linkage?.custody_leaf_hash === 'string' ? linkage.custody_leaf_hash : null,
    inclusion_proof_hash: typeof linkage?.inclusion_proof_hash === 'string' ? linkage.inclusion_proof_hash : null,
    transparency_publication_id: typeof linkage?.transparency_publication_id === 'string' ? linkage.transparency_publication_id : null,
    transparency_root_hash: typeof linkage?.transparency_root_hash === 'string' ? linkage.transparency_root_hash : null,
    transparency_chain_hash: typeof linkage?.transparency_chain_hash === 'string' ? linkage.transparency_chain_hash : null,
    previous_linkage_hash: typeof linkage?.previous_linkage_hash === 'string' ? linkage.previous_linkage_hash : null,
    linkage_hash: typeof linkage?.linkage_hash === 'string' ? linkage.linkage_hash : null,
    ...(typeof linkage?.notes === 'string' ? { notes: linkage.notes } : {}),
    integration_mode: typeof linkage?.integration_mode === 'string' ? linkage.integration_mode : 'fixture_only',
    recorded_at: typeof linkage?.recorded_at === 'string' ? linkage.recorded_at : null
  };
}

function normalizeInclusionProofLinkageRecords(linkages) {
  return (linkages ?? [])
    .map(normalizeInclusionProofLinkageRecord)
    .sort((a, b) => `${a.recorded_at ?? ''}|${a.linkage_id ?? ''}`.localeCompare(`${b.recorded_at ?? ''}|${b.linkage_id ?? ''}`));
}

function inclusionProofLinkageExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeInclusionProofLinkageExportQuery(payload?.query),
    summary: normalizeInclusionProofLinkageExportSummary(payload?.summary),
    linkages: normalizeInclusionProofLinkageRecords(payload?.linkages),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    ...(payload?.attestation ? { attestation: normalizeExportAttestation(payload.attestation) } : {}),
    ...(payload?.checkpoint ? { checkpoint: normalizeExportCheckpoint(payload.checkpoint) } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildInclusionProofLinkageExportHash({ query, summary, linkages, totalFiltered, nextCursor }) {
  return sha256HexCanonical({
    query: normalizeInclusionProofLinkageExportQuery(query),
    summary: normalizeInclusionProofLinkageExportSummary(summary),
    linkages: normalizeInclusionProofLinkageRecords(linkages),
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedInclusionProofLinkageExportPayload({
  exportedAt,
  query,
  summary,
  linkages,
  totalFiltered,
  nextCursor,
  withAttestation,
  withCheckpoint,
  keyId
}) {
  const normalizedQuery = normalizeInclusionProofLinkageExportQuery(query);
  const normalizedSummary = normalizeInclusionProofLinkageExportSummary(summary);
  const normalizedLinkages = normalizeInclusionProofLinkageRecords(linkages);
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0;

  const exportHash = buildInclusionProofLinkageExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    linkages: normalizedLinkages,
    totalFiltered: normalizedTotalFiltered,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    linkages: normalizedLinkages,
    total_filtered: normalizedTotalFiltered,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor,
      exportHash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildPolicyAuditExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null,
      nextCursor,
      entriesCount: normalizedLinkages.length,
      totalFiltered: normalizedTotalFiltered
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyInclusionProofLinkageExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildInclusionProofLinkageExportHash({
    query: payload.query,
    summary: payload.summary,
    linkages: payload.linkages,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.linkages) ? payload.linkages.length : 0,
      totalFiltered: Number.isFinite(payload.total_filtered) ? Number(payload.total_filtered) : 0
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = inclusionProofLinkageExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyInclusionProofLinkageExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildInclusionProofLinkageExportHash({
    query: payload.query,
    summary: payload.summary,
    linkages: payload.linkages,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.linkages) ? payload.linkages.length : 0,
      totalFiltered: Number.isFinite(payload.total_filtered) ? Number(payload.total_filtered) : 0
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = inclusionProofLinkageExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizeCrossAdapterCompensationLedgerExportQuery(query) {
  const out = {};

  if (typeof query?.case_id === 'string' && query.case_id.trim()) out.case_id = query.case_id.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizeCrossAdapterCompensationLedgerSummary(summary) {
  return {
    total_entries: Number.isFinite(summary?.total_entries) ? Number(summary.total_entries) : 0,
    returned_entries: Number.isFinite(summary?.returned_entries) ? Number(summary.returned_entries) : 0,
    total_amount_usd_micros: Number.isFinite(summary?.total_amount_usd_micros) ? Number(summary.total_amount_usd_micros) : 0,
    returned_amount_usd_micros: Number.isFinite(summary?.returned_amount_usd_micros) ? Number(summary.returned_amount_usd_micros) : 0,
    entry_type_breakdown: Array.isArray(summary?.entry_type_breakdown)
      ? summary.entry_type_breakdown
        .map(row => ({
          entry_type: row?.entry_type,
          entries: Number.isFinite(row?.entries) ? Number(row.entries) : 0,
          amount_usd_micros: Number.isFinite(row?.amount_usd_micros) ? Number(row.amount_usd_micros) : 0
        }))
        .sort((a, b) => String(a.entry_type ?? '').localeCompare(String(b.entry_type ?? '')))
      : []
  };
}

function normalizeCrossAdapterCompensationLedgerEntry(entry) {
  return {
    entry_id: entry?.entry_id,
    partner_id: entry?.partner_id,
    case_id: entry?.case_id,
    cycle_id: entry?.cycle_id,
    cross_receipt_id: entry?.cross_receipt_id,
    entry_type: entry?.entry_type,
    amount_usd_micros: Number.isFinite(entry?.amount_usd_micros) ? Number(entry.amount_usd_micros) : 0,
    reason_code: entry?.reason_code,
    settlement_reference: entry?.settlement_reference ?? null,
    integration_mode: entry?.integration_mode,
    recorded_at: entry?.recorded_at,
    ...(typeof entry?.notes === 'string' ? { notes: entry.notes } : {})
  };
}

function normalizeCrossAdapterCompensationLedgerEntries(entries) {
  return (entries ?? [])
    .map(normalizeCrossAdapterCompensationLedgerEntry)
    .sort((a, b) => `${a.recorded_at ?? ''}|${a.entry_id ?? ''}`.localeCompare(`${b.recorded_at ?? ''}|${b.entry_id ?? ''}`));
}

function crossAdapterCompensationLedgerExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeCrossAdapterCompensationLedgerExportQuery(payload?.query),
    summary: normalizeCrossAdapterCompensationLedgerSummary(payload?.summary),
    entries: normalizeCrossAdapterCompensationLedgerEntries(payload?.entries),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    ...(payload?.attestation ? { attestation: normalizeExportAttestation(payload.attestation) } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildCrossAdapterCompensationLedgerExportHash({ query, summary, entries, totalFiltered, nextCursor }) {
  return sha256HexCanonical({
    query: normalizeCrossAdapterCompensationLedgerExportQuery(query),
    summary: normalizeCrossAdapterCompensationLedgerSummary(summary),
    entries: normalizeCrossAdapterCompensationLedgerEntries(entries),
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedCrossAdapterCompensationLedgerExportPayload({
  exportedAt,
  query,
  summary,
  entries,
  totalFiltered,
  nextCursor,
  withAttestation,
  keyId
}) {
  const normalizedQuery = normalizeCrossAdapterCompensationLedgerExportQuery(query);
  const normalizedSummary = normalizeCrossAdapterCompensationLedgerSummary(summary);
  const normalizedEntries = normalizeCrossAdapterCompensationLedgerEntries(entries);
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0;

  const exportHash = buildCrossAdapterCompensationLedgerExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    entries: normalizedEntries,
    totalFiltered: normalizedTotalFiltered,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    entries: normalizedEntries,
    total_filtered: normalizedTotalFiltered,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor,
      exportHash
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyCrossAdapterCompensationLedgerExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildCrossAdapterCompensationLedgerExportHash({
    query: payload.query,
    summary: payload.summary,
    entries: payload.entries,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  const signable = crossAdapterCompensationLedgerExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyCrossAdapterCompensationLedgerExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildCrossAdapterCompensationLedgerExportHash({
    query: payload.query,
    summary: payload.summary,
    entries: payload.entries,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  const signable = crossAdapterCompensationLedgerExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizeDisputeCompensationLinkageExportQuery(query) {
  const out = {};

  if (typeof query?.dispute_id === 'string' && query.dispute_id.trim()) out.dispute_id = query.dispute_id.trim();
  if (typeof query?.case_id === 'string' && query.case_id.trim()) out.case_id = query.case_id.trim();
  if (typeof query?.status === 'string' && query.status.trim()) out.status = query.status.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizeDisputeCompensationLinkageHistoryEntry(entry) {
  return {
    from_status: entry?.from_status ?? null,
    to_status: entry?.to_status,
    decision_reason_code: entry?.decision_reason_code ?? null,
    ledger_entry_id: entry?.ledger_entry_id ?? null,
    occurred_at: entry?.occurred_at,
    ...(typeof entry?.notes === 'string' ? { notes: entry.notes } : {})
  };
}

function normalizeDisputeCompensationLinkageRecord(record) {
  return {
    linkage_id: record?.linkage_id,
    partner_id: record?.partner_id,
    dispute_id: record?.dispute_id,
    case_id: record?.case_id,
    cycle_id: record?.cycle_id,
    cross_receipt_id: record?.cross_receipt_id,
    status: record?.status,
    ledger_entry_id: record?.ledger_entry_id ?? null,
    decision_reason_code: record?.decision_reason_code ?? null,
    opened_at: record?.opened_at,
    updated_at: record?.updated_at,
    closed_at: record?.closed_at ?? null,
    integration_mode: record?.integration_mode,
    ...(typeof record?.notes === 'string' ? { notes: record.notes } : {}),
    history: Array.isArray(record?.history)
      ? record.history.map(normalizeDisputeCompensationLinkageHistoryEntry)
      : []
  };
}

function normalizeDisputeCompensationLinkageRecords(records) {
  return (records ?? [])
    .map(normalizeDisputeCompensationLinkageRecord)
    .sort((a, b) => `${a.updated_at ?? ''}|${a.linkage_id ?? ''}`.localeCompare(`${b.updated_at ?? ''}|${b.linkage_id ?? ''}`));
}

function normalizeDisputeCompensationLinkageExportSummary(summary) {
  return {
    total_linkages: Number.isFinite(summary?.total_linkages) ? Number(summary.total_linkages) : 0,
    returned_linkages: Number.isFinite(summary?.returned_linkages) ? Number(summary.returned_linkages) : 0,
    linked_to_ledger_count: Number.isFinite(summary?.linked_to_ledger_count) ? Number(summary.linked_to_ledger_count) : 0,
    closed_count: Number.isFinite(summary?.closed_count) ? Number(summary.closed_count) : 0,
    by_status: Array.isArray(summary?.by_status)
      ? summary.by_status
        .map(row => ({
          status: row?.status,
          count: Number.isFinite(row?.count) ? Number(row.count) : 0
        }))
        .sort((a, b) => String(a.status ?? '').localeCompare(String(b.status ?? '')))
      : []
  };
}

function disputeCompensationLinkageExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeDisputeCompensationLinkageExportQuery(payload?.query),
    summary: normalizeDisputeCompensationLinkageExportSummary(payload?.summary),
    linkages: normalizeDisputeCompensationLinkageRecords(payload?.linkages),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    ...(payload?.attestation ? { attestation: normalizeExportAttestation(payload.attestation) } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildDisputeCompensationLinkageExportHash({ query, summary, linkages, totalFiltered, nextCursor }) {
  return sha256HexCanonical({
    query: normalizeDisputeCompensationLinkageExportQuery(query),
    summary: normalizeDisputeCompensationLinkageExportSummary(summary),
    linkages: normalizeDisputeCompensationLinkageRecords(linkages),
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedDisputeCompensationLinkageExportPayload({
  exportedAt,
  query,
  summary,
  linkages,
  totalFiltered,
  nextCursor,
  withAttestation,
  keyId
}) {
  const normalizedQuery = normalizeDisputeCompensationLinkageExportQuery(query);
  const normalizedSummary = normalizeDisputeCompensationLinkageExportSummary(summary);
  const normalizedLinkages = normalizeDisputeCompensationLinkageRecords(linkages);
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0;

  const exportHash = buildDisputeCompensationLinkageExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    linkages: normalizedLinkages,
    totalFiltered: normalizedTotalFiltered,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    linkages: normalizedLinkages,
    total_filtered: normalizedTotalFiltered,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor,
      exportHash
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyDisputeCompensationLinkageExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildDisputeCompensationLinkageExportHash({
    query: payload.query,
    summary: payload.summary,
    linkages: payload.linkages,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  const signable = disputeCompensationLinkageExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyDisputeCompensationLinkageExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildDisputeCompensationLinkageExportHash({
    query: payload.query,
    summary: payload.summary,
    linkages: payload.linkages,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  const signable = disputeCompensationLinkageExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizeReliabilityRemediationPlanExportQuery(query) {
  const out = {};

  if (typeof query?.service_id === 'string' && query.service_id.trim()) out.service_id = query.service_id.trim();
  if (typeof query?.risk_level === 'string' && query.risk_level.trim()) out.risk_level = query.risk_level.trim();
  if (typeof query?.status === 'string' && query.status.trim()) out.status = query.status.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizeReliabilityRemediationPlanWindow(window) {
  return {
    from_iso: window?.from_iso,
    to_iso: window?.to_iso
  };
}

function normalizeReliabilityRemediationPlanSignalSummary(summary) {
  return {
    slo_total: Number.isFinite(summary?.slo_total) ? Number(summary.slo_total) : 0,
    slo_failing: Number.isFinite(summary?.slo_failing) ? Number(summary.slo_failing) : 0,
    drills_total: Number.isFinite(summary?.drills_total) ? Number(summary.drills_total) : 0,
    drills_failing: Number.isFinite(summary?.drills_failing) ? Number(summary.drills_failing) : 0,
    replay_checks_total: Number.isFinite(summary?.replay_checks_total) ? Number(summary.replay_checks_total) : 0,
    replay_checks_failing: Number.isFinite(summary?.replay_checks_failing) ? Number(summary.replay_checks_failing) : 0,
    availability_failures: Number.isFinite(summary?.availability_failures) ? Number(summary.availability_failures) : 0,
    latency_failures: Number.isFinite(summary?.latency_failures) ? Number(summary.latency_failures) : 0,
    error_budget_failures: Number.isFinite(summary?.error_budget_failures) ? Number(summary.error_budget_failures) : 0,
    replay_log_failures: Number.isFinite(summary?.replay_log_failures) ? Number(summary.replay_log_failures) : 0,
    replay_state_failures: Number.isFinite(summary?.replay_state_failures) ? Number(summary.replay_state_failures) : 0,
    signal_count: Number.isFinite(summary?.signal_count) ? Number(summary.signal_count) : 0,
    total_failing: Number.isFinite(summary?.total_failing) ? Number(summary.total_failing) : 0
  };
}

function normalizeReliabilityRemediationAction(action) {
  return {
    action_id: action?.action_id,
    action_code: action?.action_code,
    priority: action?.priority,
    reason_code: action?.reason_code,
    runbook_ref: action?.runbook_ref,
    automation_hint: action?.automation_hint,
    evidence_hint: action?.evidence_hint,
    ...(typeof action?.notes === 'string' ? { notes: action.notes } : {})
  };
}

function normalizeReliabilityRemediationBlocker(blocker) {
  return {
    blocker_code: blocker?.blocker_code,
    severity: blocker?.severity,
    reason_code: blocker?.reason_code,
    message: blocker?.message
  };
}

function normalizeReliabilityRemediationPlanRecord(record) {
  return {
    plan_id: record?.plan_id,
    partner_id: record?.partner_id,
    service_id: record?.service_id,
    status: record?.status,
    risk_level: record?.risk_level,
    priority_score: Number.isFinite(record?.priority_score) ? Number(record.priority_score) : 0,
    window: normalizeReliabilityRemediationPlanWindow(record?.window),
    signal_summary: normalizeReliabilityRemediationPlanSignalSummary(record?.signal_summary),
    recommended_actions: Array.isArray(record?.recommended_actions)
      ? record.recommended_actions
        .map(normalizeReliabilityRemediationAction)
        .sort((a, b) => String(a.action_code ?? '').localeCompare(String(b.action_code ?? '')))
      : [],
    blockers: Array.isArray(record?.blockers)
      ? record.blockers
        .map(normalizeReliabilityRemediationBlocker)
        .sort((a, b) => String(a.blocker_code ?? '').localeCompare(String(b.blocker_code ?? '')))
      : [],
    integration_mode: record?.integration_mode,
    created_at: record?.created_at,
    updated_at: record?.updated_at,
    ...(typeof record?.notes === 'string' ? { notes: record.notes } : {})
  };
}

function normalizeReliabilityRemediationPlanRecords(records) {
  return (records ?? [])
    .map(normalizeReliabilityRemediationPlanRecord)
    .sort((a, b) => `${a.updated_at ?? ''}|${a.plan_id ?? ''}`.localeCompare(`${b.updated_at ?? ''}|${b.plan_id ?? ''}`));
}

function normalizeReliabilityRemediationPlanExportSummary(summary) {
  return {
    total_plans: Number.isFinite(summary?.total_plans) ? Number(summary.total_plans) : 0,
    returned_plans: Number.isFinite(summary?.returned_plans) ? Number(summary.returned_plans) : 0,
    actionable_plans: Number.isFinite(summary?.actionable_plans) ? Number(summary.actionable_plans) : 0,
    critical_count: Number.isFinite(summary?.critical_count) ? Number(summary.critical_count) : 0,
    high_count: Number.isFinite(summary?.high_count) ? Number(summary.high_count) : 0,
    medium_count: Number.isFinite(summary?.medium_count) ? Number(summary.medium_count) : 0,
    low_count: Number.isFinite(summary?.low_count) ? Number(summary.low_count) : 0,
    by_status: Array.isArray(summary?.by_status)
      ? summary.by_status
        .map(row => ({
          status: row?.status,
          count: Number.isFinite(row?.count) ? Number(row.count) : 0
        }))
        .sort((a, b) => String(a.status ?? '').localeCompare(String(b.status ?? '')))
      : []
  };
}

function reliabilityRemediationPlanExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeReliabilityRemediationPlanExportQuery(payload?.query),
    summary: normalizeReliabilityRemediationPlanExportSummary(payload?.summary),
    plans: normalizeReliabilityRemediationPlanRecords(payload?.plans),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    ...(payload?.attestation ? { attestation: normalizeExportAttestation(payload.attestation) } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildReliabilityRemediationPlanExportHash({ query, summary, plans, totalFiltered, nextCursor }) {
  return sha256HexCanonical({
    query: normalizeReliabilityRemediationPlanExportQuery(query),
    summary: normalizeReliabilityRemediationPlanExportSummary(summary),
    plans: normalizeReliabilityRemediationPlanRecords(plans),
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedReliabilityRemediationPlanExportPayload({
  exportedAt,
  query,
  summary,
  plans,
  totalFiltered,
  nextCursor,
  withAttestation,
  keyId
}) {
  const normalizedQuery = normalizeReliabilityRemediationPlanExportQuery(query);
  const normalizedSummary = normalizeReliabilityRemediationPlanExportSummary(summary);
  const normalizedPlans = normalizeReliabilityRemediationPlanRecords(plans);
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0;

  const exportHash = buildReliabilityRemediationPlanExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    plans: normalizedPlans,
    totalFiltered: normalizedTotalFiltered,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    plans: normalizedPlans,
    total_filtered: normalizedTotalFiltered,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor,
      exportHash
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyReliabilityRemediationPlanExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildReliabilityRemediationPlanExportHash({
    query: payload.query,
    summary: payload.summary,
    plans: payload.plans,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  const signable = reliabilityRemediationPlanExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyReliabilityRemediationPlanExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildReliabilityRemediationPlanExportHash({
    query: payload.query,
    summary: payload.summary,
    plans: payload.plans,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  const signable = reliabilityRemediationPlanExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}

function normalizeStagingEvidenceBundleExportQuery(query) {
  const out = {};

  if (typeof query?.milestone_id === 'string' && query.milestone_id.trim()) out.milestone_id = query.milestone_id.trim();
  if (typeof query?.environment === 'string' && query.environment.trim()) out.environment = query.environment.trim();
  if (typeof query?.from_iso === 'string' && query.from_iso.trim()) out.from_iso = query.from_iso.trim();
  if (typeof query?.to_iso === 'string' && query.to_iso.trim()) out.to_iso = query.to_iso.trim();

  if (Number.isFinite(query?.limit)) out.limit = Number(query.limit);
  else {
    const limit = Number.parseInt(String(query?.limit ?? ''), 10);
    if (Number.isFinite(limit)) out.limit = limit;
  }

  if (typeof query?.cursor_after === 'string' && query.cursor_after.trim()) out.cursor_after = query.cursor_after.trim();
  if (typeof query?.attestation_after === 'string' && query.attestation_after.trim()) out.attestation_after = query.attestation_after.trim();
  if (typeof query?.checkpoint_after === 'string' && query.checkpoint_after.trim()) out.checkpoint_after = query.checkpoint_after.trim();
  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
}

function normalizeStagingEvidenceItem(item) {
  return {
    artifact_ref: item?.artifact_ref,
    artifact_kind: item?.artifact_kind,
    sha256: item?.sha256,
    captured_at: item?.captured_at ?? null
  };
}

function normalizeStagingEvidenceItems(items) {
  return (items ?? [])
    .map(normalizeStagingEvidenceItem)
    .sort((a, b) => `${a.artifact_ref ?? ''}|${a.artifact_kind ?? ''}|${a.sha256 ?? ''}`.localeCompare(`${b.artifact_ref ?? ''}|${b.artifact_kind ?? ''}|${b.sha256 ?? ''}`));
}

function normalizeStagingEvidenceBundleRecord(record) {
  return {
    bundle_id: record?.bundle_id,
    partner_id: record?.partner_id,
    milestone_id: record?.milestone_id,
    environment: record?.environment,
    runbook_ref: record?.runbook_ref,
    conformance_ref: record?.conformance_ref ?? null,
    release_ref: record?.release_ref ?? null,
    collected_at: record?.collected_at,
    evidence_items: normalizeStagingEvidenceItems(record?.evidence_items),
    evidence_count: Number.isFinite(record?.evidence_count) ? Number(record.evidence_count) : 0,
    manifest_hash: record?.manifest_hash,
    checkpoint_after: record?.checkpoint_after ?? null,
    checkpoint_hash: record?.checkpoint_hash,
    integration_mode: record?.integration_mode,
    recorded_at: record?.recorded_at,
    ...(typeof record?.notes === 'string' ? { notes: record.notes } : {})
  };
}

function normalizeStagingEvidenceBundleRecords(records) {
  return (records ?? [])
    .map(normalizeStagingEvidenceBundleRecord)
    .sort((a, b) => `${a.recorded_at ?? ''}|${a.bundle_id ?? ''}`.localeCompare(`${b.recorded_at ?? ''}|${b.bundle_id ?? ''}`));
}

function normalizeStagingEvidenceBundleExportSummary(summary) {
  return {
    total_bundles: Number.isFinite(summary?.total_bundles) ? Number(summary.total_bundles) : 0,
    returned_bundles: Number.isFinite(summary?.returned_bundles) ? Number(summary.returned_bundles) : 0,
    total_evidence_items: Number.isFinite(summary?.total_evidence_items) ? Number(summary.total_evidence_items) : 0,
    returned_evidence_items: Number.isFinite(summary?.returned_evidence_items) ? Number(summary.returned_evidence_items) : 0,
    latest_checkpoint_hash: typeof summary?.latest_checkpoint_hash === 'string' ? summary.latest_checkpoint_hash : null,
    by_milestone: Array.isArray(summary?.by_milestone)
      ? summary.by_milestone
        .map(row => ({
          milestone_id: row?.milestone_id,
          count: Number.isFinite(row?.count) ? Number(row.count) : 0
        }))
        .sort((a, b) => String(a.milestone_id ?? '').localeCompare(String(b.milestone_id ?? '')))
      : []
  };
}

function stagingEvidenceBundleExportSignablePayload(payload) {
  return {
    exported_at: payload?.exported_at,
    query: normalizeStagingEvidenceBundleExportQuery(payload?.query),
    summary: normalizeStagingEvidenceBundleExportSummary(payload?.summary),
    bundles: normalizeStagingEvidenceBundleRecords(payload?.bundles),
    total_filtered: Number.isFinite(payload?.total_filtered) ? Number(payload.total_filtered) : 0,
    ...(typeof payload?.next_cursor === 'string' ? { next_cursor: payload.next_cursor } : {}),
    ...(payload?.attestation ? { attestation: normalizeExportAttestation(payload.attestation) } : {}),
    ...(payload?.checkpoint ? { checkpoint: normalizeExportCheckpoint(payload.checkpoint) } : {}),
    export_hash: payload?.export_hash,
    signature: payload?.signature
  };
}

export function buildStagingEvidenceBundleExportHash({ query, summary, bundles, totalFiltered, nextCursor }) {
  return sha256HexCanonical({
    query: normalizeStagingEvidenceBundleExportQuery(query),
    summary: normalizeStagingEvidenceBundleExportSummary(summary),
    bundles: normalizeStagingEvidenceBundleRecords(bundles),
    total_filtered: Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {})
  });
}

export function buildSignedStagingEvidenceBundleExportPayload({
  exportedAt,
  query,
  summary,
  bundles,
  totalFiltered,
  nextCursor,
  withAttestation,
  withCheckpoint,
  keyId
}) {
  const normalizedQuery = normalizeStagingEvidenceBundleExportQuery(query);
  const normalizedSummary = normalizeStagingEvidenceBundleExportSummary(summary);
  const normalizedBundles = normalizeStagingEvidenceBundleRecords(bundles);
  const normalizedTotalFiltered = Number.isFinite(totalFiltered) ? Number(totalFiltered) : 0;

  const exportHash = buildStagingEvidenceBundleExportHash({
    query: normalizedQuery,
    summary: normalizedSummary,
    bundles: normalizedBundles,
    totalFiltered: normalizedTotalFiltered,
    nextCursor
  });

  const payload = {
    exported_at: exportedAt,
    query: normalizedQuery,
    summary: normalizedSummary,
    bundles: normalizedBundles,
    total_filtered: normalizedTotalFiltered,
    ...(typeof nextCursor === 'string' ? { next_cursor: nextCursor } : {}),
    export_hash: exportHash
  };

  if (withAttestation) {
    payload.attestation = buildPolicyAuditExportAttestation({
      query: normalizedQuery,
      nextCursor,
      exportHash
    });
  }

  if (withCheckpoint) {
    payload.checkpoint = buildPolicyAuditExportCheckpoint({
      query: normalizedQuery,
      attestation: payload.attestation ?? null,
      nextCursor,
      entriesCount: normalizedBundles.length,
      totalFiltered: normalizedTotalFiltered
    });
  }

  payload.signature = signPolicyIntegrityPayload(payload, { keyId });
  return payload;
}

export function verifyStagingEvidenceBundleExportPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildStagingEvidenceBundleExportHash({
    query: payload.query,
    summary: payload.summary,
    bundles: payload.bundles,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.bundles) ? payload.bundles.length : 0,
      totalFiltered: Number.isFinite(payload.total_filtered) ? Number(payload.total_filtered) : 0
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = stagingEvidenceBundleExportSignablePayload(payload);
  const verified = verifyPolicyIntegrityPayloadSignature(signable);
  if (!verified.ok) return verified;

  return { ok: true };
}

export function verifyStagingEvidenceBundleExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg }) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'missing_payload' };

  const expectedHash = buildStagingEvidenceBundleExportHash({
    query: payload.query,
    summary: payload.summary,
    bundles: payload.bundles,
    totalFiltered: payload.total_filtered,
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
    const attestation = verifyPolicyAuditExportAttestation({
      attestation: payload.attestation,
      query: payload.query,
      nextCursor: payload.next_cursor,
      exportHash: expectedHash
    });
    if (!attestation.ok) return attestation;
  }

  if (payload.checkpoint) {
    const checkpoint = verifyPolicyAuditExportCheckpoint({
      checkpoint: payload.checkpoint,
      query: payload.query,
      attestation: payload.attestation ?? null,
      nextCursor: payload.next_cursor,
      entriesCount: Array.isArray(payload.bundles) ? payload.bundles.length : 0,
      totalFiltered: Number.isFinite(payload.total_filtered) ? Number(payload.total_filtered) : 0
    });
    if (!checkpoint.ok) return checkpoint;
  }

  const signable = stagingEvidenceBundleExportSignablePayload(payload);
  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({ payload: signable, publicKeyPem, keyId, alg });
}
