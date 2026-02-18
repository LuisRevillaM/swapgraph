import { readFileSync } from 'node:fs';
import path from 'node:path';

import { verifyEventSignatureWithPublicKeyPem } from '../src/crypto/eventSigning.mjs';

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function looksLikeEventEnvelopeCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  if (typeof value.event_id !== 'string' || value.event_id.length === 0) return false;
  if (typeof value.type !== 'string' || value.type.length === 0) return false;
  if (typeof value.occurred_at !== 'string' || value.occurred_at.length === 0) return false;
  if (typeof value.correlation_id !== 'string' || value.correlation_id.length === 0) return false;

  const actor = value.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false;
  if (typeof actor.type !== 'string' || actor.type.length === 0) return false;
  if (typeof actor.id !== 'string' || actor.id.length === 0) return false;

  const payload = value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  return true;
}

function collectEnvelopesFromJson(node, out, where = '$') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectEnvelopesFromJson(node[i], out, `${where}[${i}]`);
    }
    return;
  }

  if (!node || typeof node !== 'object') return;

  if (looksLikeEventEnvelopeCandidate(node)) {
    out.push({ where, envelope: node });
  }

  for (const [k, v] of Object.entries(node)) {
    collectEnvelopesFromJson(v, out, `${where}.${k}`);
  }
}

function collectEnvelopesFromNdjson(text, out) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `$[${i}]`;

    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      out.push({ where, envelope: null, parse_error: 'invalid_json' });
      continue;
    }

    if (looksLikeEventEnvelopeCandidate(evt)) {
      out.push({ where, envelope: evt });
    }
  }
}

function parseArgs(argv) {
  const args = { files: [], keysExamplePath: 'docs/spec/examples/api/keys.event_signing.get.response.json' };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keys-example') {
      args.keysExamplePath = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      throw new Error(`Unknown arg: ${a}`);
    }
    args.files.push(a);
  }

  return args;
}

function loadKeySet(keysExamplePath) {
  const ks = readJson(keysExamplePath);
  const keys = ks?.keys ?? [];
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`keys example contains no keys: ${keysExamplePath}`);
  }
  return ks;
}

function findKeyForEnvelope({ keySet, envelope }) {
  const keyId = envelope?.signature?.key_id;
  const keys = keySet.keys ?? [];
  return (keys ?? []).find(k => k?.key_id === keyId) ?? null;
}

function envelopeSignatureSummary(envelope) {
  const sig = envelope?.signature;
  return {
    key_id: sig?.key_id ?? null,
    alg: sig?.alg ?? null,
    sig_present: typeof sig?.sig === 'string' && sig.sig.length > 0
  };
}

const { files, keysExamplePath } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error('Usage: node scripts/verify-event-signatures.mjs [--keys-example <path>] <file1> <file2> ...');
  process.exit(2);
}

const keySet = loadKeySet(keysExamplePath);

const fileResults = [];
const allEnvelopes = [];

for (const file of files) {
  const ext = path.extname(file);
  const envelopes = [];
  const raw = readFileSync(file, 'utf8');

  if (ext === '.ndjson') {
    collectEnvelopesFromNdjson(raw, envelopes);
  } else {
    const doc = JSON.parse(raw);
    collectEnvelopesFromJson(doc, envelopes);
  }

  const verifications = [];
  for (const e of envelopes) {
    if (!e.envelope) {
      verifications.push({ where: e.where, ok: false, error: e.parse_error ?? 'unknown' });
      continue;
    }

    if (!e.envelope.signature) {
      verifications.push({
        where: e.where,
        ok: false,
        error: 'missing_signature',
        event_id: e.envelope.event_id,
        type: e.envelope.type,
        ...envelopeSignatureSummary(e.envelope)
      });
      continue;
    }

    const k = findKeyForEnvelope({ keySet, envelope: e.envelope });
    if (!k) {
      verifications.push({
        where: e.where,
        ok: false,
        error: 'unknown_key_id',
        event_id: e.envelope.event_id,
        type: e.envelope.type,
        ...envelopeSignatureSummary(e.envelope)
      });
      continue;
    }

    const v = verifyEventSignatureWithPublicKeyPem({
      envelope: e.envelope,
      publicKeyPem: k.public_key_pem,
      keyId: k.key_id,
      alg: k.alg
    });

    verifications.push({
      where: e.where,
      ok: v.ok,
      error: v.ok ? null : v.error,
      event_id: e.envelope.event_id,
      type: e.envelope.type,
      ...envelopeSignatureSummary(e.envelope)
    });

    allEnvelopes.push(e.envelope);
  }

  fileResults.push({ file, envelopes_found: envelopes.filter(x => !!x.envelope).length, verifications });
}

const allOk = fileResults.every(fr => fr.verifications.every(v => v.ok));

// Tamper test: mutate a verified envelope and ensure verification fails.
let tamper = { performed: false, ok: false, error: null };
const firstEnvelope = allEnvelopes[0] ?? null;
if (firstEnvelope) {
  const k = findKeyForEnvelope({ keySet, envelope: firstEnvelope });
  if (!k) {
    tamper = { performed: true, ok: false, error: 'missing_key_for_first_envelope' };
  } else {
    const tampered = JSON.parse(JSON.stringify(firstEnvelope));
    tampered.correlation_id = `${tampered.correlation_id}_tampered`;

    const v = verifyEventSignatureWithPublicKeyPem({
      envelope: tampered,
      publicKeyPem: k.public_key_pem,
      keyId: k.key_id,
      alg: k.alg
    });

    tamper = {
      performed: true,
      ok: v.ok === false,
      error: v.ok ? 'tamper_should_fail_but_verified' : v.error
    };
  }
}

const overall = allOk && tamper.ok;

const out = {
  overall,
  keys_example: keysExamplePath,
  files: fileResults,
  tamper
};

if (!overall) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(out, null, 2));
