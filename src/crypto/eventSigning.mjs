import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalStringify } from '../util/canonicalJson.mjs';

const KEY_ID = 'dev-ev-k1';
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
  const privPem = readFileSync(path.join(root, 'fixtures/keys/event_signing_dev_ev_k1_private.pem'), 'utf8');
  const pubPem = readFileSync(path.join(root, 'fixtures/keys/event_signing_dev_ev_k1_public.pem'), 'utf8');

  const privateKey = crypto.createPrivateKey(privPem);
  const publicKey = crypto.createPublicKey(pubPem);

  _keys = { privateKey, publicKey };
  return _keys;
}

function eventSigningMessage(envelope) {
  const unsigned = JSON.parse(JSON.stringify(envelope));
  delete unsigned.signature;
  return Buffer.from(canonicalStringify(unsigned), 'utf8');
}

export function eventSigningMessageBytes(envelope) {
  return eventSigningMessage(envelope);
}

export function signEventEnvelope(envelope) {
  const { privateKey } = getKeys();
  const msg = eventSigningMessage(envelope);
  const sig = crypto.sign(null, msg, privateKey);

  return {
    key_id: KEY_ID,
    alg: ALG,
    sig: sig.toString('base64')
  };
}

export function verifyEventSignature(envelope) {
  const { publicKey } = getKeys();

  const sigB64 = envelope?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  if (envelope.signature.key_id !== KEY_ID) {
    return { ok: false, error: 'unknown_key_id', details: { key_id: envelope.signature.key_id } };
  }
  if (envelope.signature.alg !== ALG) {
    return { ok: false, error: 'unsupported_alg', details: { alg: envelope.signature.alg } };
  }

  let sig;
  try {
    sig = Buffer.from(sigB64, 'base64');
  } catch {
    return { ok: false, error: 'invalid_base64' };
  }

  const msg = eventSigningMessage(envelope);
  const ok = crypto.verify(null, msg, publicKey, sig);
  return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
}

export function verifyEventSignatureWithPublicKeyPem({ envelope, publicKeyPem, keyId, alg }) {
  if (!publicKeyPem) return { ok: false, error: 'missing_public_key' };

  const sigB64 = envelope?.signature?.sig;
  if (!sigB64) return { ok: false, error: 'missing_signature' };

  if (keyId && envelope?.signature?.key_id !== keyId) {
    return { ok: false, error: 'unknown_key_id', details: { key_id: envelope?.signature?.key_id ?? null } };
  }

  if (alg && envelope?.signature?.alg !== alg) {
    return { ok: false, error: 'unsupported_alg', details: { alg: envelope?.signature?.alg ?? null } };
  }

  // v1 supports Ed25519 event signatures.
  if (envelope?.signature?.alg !== 'ed25519') {
    return { ok: false, error: 'unsupported_alg', details: { alg: envelope?.signature?.alg ?? null } };
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

  const msg = eventSigningMessage(envelope);
  const ok = crypto.verify(null, msg, publicKey, sig);
  return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
}
