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

function normalizeVaultReconciliationExportQuery(query) {
  const out = {};

  if (typeof query?.cycle_id === 'string' && query.cycle_id.trim()) out.cycle_id = query.cycle_id.trim();

  if (typeof query?.include_transitions === 'boolean') {
    out.include_transitions = query.include_transitions;
  }

  if (typeof query?.now_iso === 'string' && query.now_iso.trim()) out.now_iso = query.now_iso.trim();
  if (typeof query?.exported_at_iso === 'string' && query.exported_at_iso.trim()) out.exported_at_iso = query.exported_at_iso.trim();

  return out;
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

  return out;
}

export function buildSettlementVaultReconciliationExportHash({
  cycleId,
  timelineState,
  vaultReconciliation,
  stateTransitions,
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

  return sha256HexCanonical(input);
}

export function buildSignedSettlementVaultReconciliationExportPayload({
  exportedAt,
  cycleId,
  timelineState,
  vaultReconciliation,
  stateTransitions,
  query,
  keyId
}) {
  const normalizedQuery = normalizeVaultReconciliationExportQuery(query);

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

  payload.export_hash = buildSettlementVaultReconciliationExportHash({
    cycleId,
    timelineState,
    vaultReconciliation,
    stateTransitions,
    query: normalizedQuery
  });

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

  const signable = vaultReconciliationExportSignablePayload(payload);

  return verifyPolicyIntegrityPayloadSignatureWithPublicKeyPem({
    payload: signable,
    publicKeyPem,
    keyId,
    alg
  });
}
