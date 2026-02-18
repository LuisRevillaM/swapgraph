import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from '../util/canonicalJson.mjs';

const TOKEN_PREFIX = 'sgdt1.';
const ALG = 'ed25519';
const DEFAULT_ACTIVE_KEY_ID = 'dev-dt-k1';

const KEY_CONFIGS = [
  {
    key_id: 'dev-dt-k1',
    private_file: 'fixtures/keys/delegation_token_signing_dev_dt_k1_private.pem',
    public_file: 'fixtures/keys/delegation_token_signing_dev_dt_k1_public.pem'
  },
  {
    key_id: 'dev-dt-k2',
    private_file: 'fixtures/keys/delegation_token_signing_dev_dt_k2_private.pem',
    public_file: 'fixtures/keys/delegation_token_signing_dev_dt_k2_public.pem'
  }
];

let _keyMaterialById;

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/crypto -> repo root
  return path.resolve(here, '../..');
}

function keyConfigById(keyId) {
  return KEY_CONFIGS.find(k => k.key_id === keyId) ?? null;
}

function resolveActiveKeyId() {
  const configured = process.env.DELEGATION_TOKEN_SIGNING_ACTIVE_KEY_ID?.trim();
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
  return map;
}

function stripRevokedAt(delegation) {
  const d = JSON.parse(JSON.stringify(delegation));
  delete d.revoked_at;
  return d;
}

function tokenSigningMessage(token) {
  const unsigned = JSON.parse(JSON.stringify(token));
  delete unsigned.signature;
  return Buffer.from(canonicalStringify(unsigned), 'utf8');
}

export function delegationTokenSigningMessageBytes(token) {
  return tokenSigningMessage(token);
}

export function getDelegationTokenSigningActiveKeyId() {
  return resolveActiveKeyId();
}

export function getDelegationTokenSigningPublicKeys() {
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

export function signDelegationToken(token, { keyId } = {}) {
  const selectedKeyId = keyId ?? resolveActiveKeyId();
  const key = getKeyMaterialMap().get(selectedKeyId);
  if (!key) {
    throw new Error(`unknown delegation token signing key id: ${selectedKeyId}`);
  }

  const msg = tokenSigningMessage(token);
  const sig = crypto.sign(null, msg, key.privateKey);

  return {
    key_id: selectedKeyId,
    alg: ALG,
    sig: sig.toString('base64')
  };
}

export function mintDelegationToken({ delegation, keyId }) {
  const token = {
    delegation: stripRevokedAt(delegation)
  };
  return { ...token, signature: signDelegationToken(token, { keyId }) };
}

export function encodeDelegationTokenString(token) {
  const json = canonicalStringify(token);
  const b64u = Buffer.from(json, 'utf8').toString('base64url');
  return `${TOKEN_PREFIX}${b64u}`;
}

export function decodeDelegationTokenString(tokenString) {
  if (!tokenString || typeof tokenString !== 'string') {
    return { ok: false, error: 'missing_token' };
  }
  if (!tokenString.startsWith(TOKEN_PREFIX)) {
    return { ok: false, error: 'unsupported_token_prefix', details: { expected_prefix: TOKEN_PREFIX } };
  }

  const b64u = tokenString.slice(TOKEN_PREFIX.length);

  let json;
  try {
    json = Buffer.from(b64u, 'base64url').toString('utf8');
  } catch {
    return { ok: false, error: 'invalid_base64url' };
  }

  let token;
  try {
    token = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  return { ok: true, token };
}

export function verifyDelegationTokenSignature(token) {
  const sigB64 = token?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  const keyId = token?.signature?.key_id;
  const key = getKeyMaterialMap().get(keyId);
  if (!key) {
    return { ok: false, error: 'unknown_key_id', details: { key_id: keyId ?? null } };
  }

  if (token?.signature?.alg !== ALG) {
    return { ok: false, error: 'unsupported_alg', details: { alg: token?.signature?.alg ?? null } };
  }

  let sig;
  try {
    sig = Buffer.from(sigB64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_base64' };
  }

  const msg = tokenSigningMessage(token);
  const ok = crypto.verify(null, msg, key.publicKey, sig);
  return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
}

export function verifyDelegationTokenSignatureWithPublicKeyPem({ token, publicKeyPem, keyId, alg }) {
  if (!publicKeyPem) return { ok: false, error: 'missing_public_key' };

  const sigB64 = token?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  if (keyId && token?.signature?.key_id !== keyId) {
    return { ok: false, error: 'unknown_key_id', details: { key_id: token?.signature?.key_id ?? null } };
  }

  if (alg && token?.signature?.alg !== alg) {
    return { ok: false, error: 'unsupported_alg', details: { alg: token?.signature?.alg ?? null } };
  }

  // v1 supports Ed25519 signatures.
  if (token?.signature?.alg !== 'ed25519') {
    return { ok: false, error: 'unsupported_alg', details: { alg: token?.signature?.alg ?? null } };
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

  const msg = tokenSigningMessage(token);
  const ok = crypto.verify(null, msg, publicKey, sig);
  return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
}

export function verifyDelegationTokenString(tokenString) {
  const decoded = decodeDelegationTokenString(tokenString);
  if (!decoded.ok) return decoded;

  const token = decoded.token;
  const v = verifyDelegationTokenSignature(token);
  if (!v.ok) return v;

  return { ok: true, token };
}
