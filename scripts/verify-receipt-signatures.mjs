import { readFileSync } from 'node:fs';
import path from 'node:path';

import { verifyReceiptSignatureWithPublicKeyPem } from '../src/crypto/receiptSigning.mjs';

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function looksLikeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.cycle_id !== 'string' || value.cycle_id.length === 0) return false;
  if (!['completed', 'failed'].includes(value.final_state)) return false;
  if (typeof value.created_at !== 'string' || value.created_at.length === 0) return false;

  const sig = value.signature;
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) return false;
  if (typeof sig.key_id !== 'string' || sig.key_id.length === 0) return false;
  if (typeof sig.alg !== 'string' || sig.alg.length === 0) return false;
  if (typeof sig.sig !== 'string' || sig.sig.length === 0) return false;

  return true;
}

function collectReceiptsFromJson(node, out, where = '$') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectReceiptsFromJson(node[i], out, `${where}[${i}]`);
    }
    return;
  }

  if (!node || typeof node !== 'object') return;

  if (looksLikeReceipt(node)) {
    out.push({ where, receipt: node });
  }

  for (const [k, v] of Object.entries(node)) {
    collectReceiptsFromJson(v, out, `${where}.${k}`);
  }
}

function collectReceiptsFromNdjson(text, out) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `$[${i}]`;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      out.push({ where, receipt: null, parse_error: 'invalid_json' });
      continue;
    }

    if (evt?.type === 'receipt.created' && looksLikeReceipt(evt?.payload?.receipt)) {
      out.push({ where: `${where}.payload.receipt`, receipt: evt.payload.receipt });
    }
  }
}

function parseArgs(argv) {
  const args = { files: [], keysExamplePath: 'docs/spec/examples/api/keys.receipt_signing.get.response.json' };

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

function findKeyForReceipt({ keySet, receipt }) {
  const keyId = receipt?.signature?.key_id;
  const keys = keySet.keys ?? [];
  return (keys ?? []).find(k => k?.key_id === keyId) ?? null;
}

const { files, keysExamplePath } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error('Usage: node scripts/verify-receipt-signatures.mjs [--keys-example <path>] <file1> <file2> ...');
  process.exit(2);
}

const keySet = loadKeySet(keysExamplePath);

const fileResults = [];
const allReceipts = [];

for (const file of files) {
  const ext = path.extname(file);
  const receipts = [];
  const raw = readFileSync(file, 'utf8');

  if (ext === '.ndjson') {
    collectReceiptsFromNdjson(raw, receipts);
  } else {
    const doc = JSON.parse(raw);
    collectReceiptsFromJson(doc, receipts);
  }

  const verifications = [];
  for (const r of receipts) {
    if (!r.receipt) {
      verifications.push({ where: r.where, ok: false, error: r.parse_error ?? 'unknown' });
      continue;
    }

    const k = findKeyForReceipt({ keySet, receipt: r.receipt });
    if (!k) {
      verifications.push({ where: r.where, ok: false, error: 'unknown_key_id', key_id: r.receipt.signature.key_id });
      continue;
    }

    const v = verifyReceiptSignatureWithPublicKeyPem({
      receipt: r.receipt,
      publicKeyPem: k.public_key_pem,
      keyId: k.key_id,
      alg: k.alg
    });

    verifications.push({
      where: r.where,
      ok: v.ok,
      error: v.ok ? null : v.error,
      key_id: r.receipt.signature.key_id,
      alg: r.receipt.signature.alg
    });

    allReceipts.push(r.receipt);
  }

  fileResults.push({ file, receipts_found: receipts.filter(r => !!r.receipt).length, verifications });
}

const allOk = fileResults.every(fr => fr.verifications.every(v => v.ok));

// Tamper test: mutate a verified receipt and ensure verification fails.
let tamper = { performed: false, ok: false, error: null };
const firstReceipt = allReceipts[0] ?? null;
if (firstReceipt) {
  const k = findKeyForReceipt({ keySet, receipt: firstReceipt });
  if (!k) {
    tamper = { performed: true, ok: false, error: 'missing_key_for_first_receipt' };
  } else {
    const tampered = JSON.parse(JSON.stringify(firstReceipt));
    tampered.cycle_id = `${tampered.cycle_id}_tampered`;

    const v = verifyReceiptSignatureWithPublicKeyPem({
      receipt: tampered,
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
