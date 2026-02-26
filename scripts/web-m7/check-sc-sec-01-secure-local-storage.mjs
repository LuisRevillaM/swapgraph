#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeOfflineSnapshotForStorage } from '../../client/marketplace/src/features/security/storagePolicy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const bootstrapPath = path.join(repoRoot, 'client/marketplace/src/app/bootstrap.mjs');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-sec-01-secure-local-storage-report.json');

function main() {
  const bootstrapSource = readFileSync(bootstrapPath, 'utf8');
  const sanitized = sanitizeOfflineSnapshotForStorage({
    version: 1,
    savedAt: Date.now(),
    caches: {
      health: { value: { ok: true }, updatedAt: 1 },
      inventoryAwakening: { value: { swappabilitySummary: { activeIntents: 2 } }, updatedAt: 2 },
      intents: { items: Array.from({ length: 200 }, (_, index) => ({ id: `intent_${index}` })), updatedAt: 3 },
      proposals: { items: Array.from({ length: 200 }, (_, index) => ({ id: `proposal_${index}` })), updatedAt: 4 },
      timeline: {
        cycle_1: { value: { cycleId: 'cycle_1', state: 'executing' }, updatedAt: 5 }
      },
      receipts: {
        cycle_1: {
          value: {
            id: 'receipt_1',
            cycleId: 'cycle_1',
            signature: { keyId: 'k1', algorithm: 'ed25519', signature: 'raw_signature_bytes' }
          },
          updatedAt: 6
        }
      }
    }
  });

  const serialized = JSON.stringify(sanitized);
  const checklist = [
    {
      id: 'storage_reads_are_guarded',
      pass: /safeStorageRead/.test(bootstrapSource)
    },
    {
      id: 'storage_writes_are_guarded',
      pass: /safeStorageWrite/.test(bootstrapSource)
    },
    {
      id: 'offline_snapshot_size_guard_present',
      pass: /MAX_OFFLINE_SNAPSHOT_BYTES/.test(bootstrapSource)
    },
    {
      id: 'snapshot_receipt_signature_redacted',
      pass: sanitized?.caches?.receipts?.cycle_1?.value?.signature?.signature === '[redacted]'
    },
    {
      id: 'snapshot_collections_are_clipped',
      pass: sanitized.caches.intents.items.length < 200 && sanitized.caches.proposals.items.length < 200
    },
    {
      id: 'snapshot_serialized_payload_bounded',
      pass: serialized.length < 320_000
    }
  ];

  const output = {
    check_id: 'SC-SEC-01',
    generated_at: new Date().toISOString(),
    source: path.relative(repoRoot, bootstrapPath),
    sanitized_snapshot_size_bytes: serialized.length,
    checklist,
    pass: checklist.every(row => row.pass)
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
