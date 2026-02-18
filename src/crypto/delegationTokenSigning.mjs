import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from '../util/canonicalJson.mjs';

const TOKEN_PREFIX = 'sgdt1.';
const KEY_ID = 'dev-dt-k1';
const ALG = 'ed25519';

let _keys;

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/crypto -> repo root
  return path.resolve(here, '../..');
}

function getKeys() {
  if (_keys) return _keys;

  const root = repoRoot();
  const privPem = readFileSync(path.join(root, 'fixtures/keys/delegation_token_signing_dev_dt_k1_private.pem'), 'utf8');
  const pubPem = readFileSync(path.join(root, 'fixtures/keys/delegation_token_signing_dev_dt_k1_public.pem'), 'utf8');

  const privateKey = crypto.createPrivateKey(privPem);
  const publicKey = crypto.createPublicKey(pubPem);

  _keys = { privateKey, publicKey };
  return _keys;
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

export function signDelegationToken(token) {
  const { privateKey } = getKeys();
  const msg = tokenSigningMessage(token);
  const sig = crypto.sign(null, msg, privateKey);

  return {
    key_id: KEY_ID,
    alg: ALG,
    sig: sig.toString('base64')
  };
}

export function mintDelegationToken({ delegation }) {
  const token = {
    delegation: stripRevokedAt(delegation)
  };
  return { ...token, signature: signDelegationToken(token) };
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
  const { publicKey } = getKeys();

  const sigB64 = token?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  if (token.signature.key_id !== KEY_ID) {
    return { ok: false, error: 'unknown_key_id', details: { key_id: token.signature.key_id } };
  }
  if (token.signature.alg !== ALG) {
    return { ok: false, error: 'unsupported_alg', details: { alg: token.signature.alg } };
  }

  let sig;
  try {
    sig = Buffer.from(sigB64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_base64' };
  }

  const msg = tokenSigningMessage(token);
  const ok = crypto.verify(null, msg, publicKey, sig);
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
