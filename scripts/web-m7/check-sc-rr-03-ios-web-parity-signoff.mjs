#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_TABS } from '../../client/marketplace/src/app/tabs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const parityDocPath = path.join(repoRoot, 'docs/prd/2026-02-24_marketplace-shared-check-catalog-and-parity-checklist.md');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-rr-03-ios-web-parity-signoff-report.json');

function readArtifact(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return { exists: false, pass: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
    return {
      exists: true,
      pass: parsed?.pass === true
    };
  } catch {
    return { exists: true, pass: false };
  }
}

function main() {
  const parityDoc = readFileSync(parityDocPath, 'utf8');
  const parityRowsInDoc = [...parityDoc.matchAll(/\|\s*(PC-[0-9]{2})\s*\|/g)].map(match => match[1]);

  const evidenceMap = [
    { id: 'PC-01', description: 'Five-tab IA parity', artifacts: [], pass: MARKETPLACE_TABS.length === 5 },
    { id: 'PC-02', description: 'First-intent flow parity', artifacts: ['artifacts/web-m2/sc-ux-01-first-intent-report.json'] },
    { id: 'PC-03', description: 'Always-running model parity', artifacts: ['artifacts/web-m2/sc-ux-01-first-intent-report.json'] },
    { id: 'PC-04', description: 'Proposal explanation primitives parity', artifacts: ['artifacts/web-m3/sc-ux-02-proposal-decision-clarity-report.json'] },
    { id: 'PC-05', description: 'Accept/decline semantics parity', artifacts: ['artifacts/web-m3/sc-api-03-idempotency-report.json'] },
    { id: 'PC-06', description: 'Active wait reason semantics parity', artifacts: ['artifacts/web-m4/sc-ux-03-active-timeline-clarity-report.json'] },
    { id: 'PC-07', description: 'Receipt metadata parity', artifacts: ['artifacts/web-m5/sc-ux-04-receipt-clarity-report.json'] },
    { id: 'PC-08', description: 'Error envelope rendering parity', artifacts: ['artifacts/web-m4/sc-api-04-error-envelope-consistency-report.json'] },
    { id: 'PC-09', description: 'Analytics taxonomy parity', artifacts: ['artifacts/web-m6/sc-an-01-event-taxonomy-report.json', 'artifacts/web-m3/sc-an-02-funnel-ordering-report.json'] },
    { id: 'PC-10', description: 'Offline stale banner parity', artifacts: ['artifacts/web-m6/sc-rl-03-stale-data-signaling-report.json'] },
    { id: 'PC-11', description: 'Security posture parity', artifacts: ['artifacts/web-m7/sc-sec-01-secure-local-storage-report.json', 'artifacts/web-m7/sc-sec-02-session-auth-boundary-controls-report.json', 'artifacts/web-m7/sc-sec-03-privacy-log-redaction-report.json'] },
    { id: 'PC-12', description: 'Accessibility floor parity', artifacts: ['artifacts/web-m7/sc-ax-01-contrast-readability-report.json', 'artifacts/web-m7/sc-ax-02-assistive-semantics-focus-order-report.json', 'artifacts/web-m7/sc-ax-03-touch-target-baseline-report.json'] }
  ].map(row => {
    if (typeof row.pass === 'boolean') {
      return {
        ...row,
        artifact_rows: [],
        pass: row.pass
      };
    }
    const artifactRows = row.artifacts.map(artifact => {
      const result = readArtifact(artifact);
      return {
        artifact,
        exists: result.exists,
        pass: result.pass
      };
    });
    return {
      ...row,
      artifact_rows: artifactRows,
      pass: artifactRows.every(item => item.exists && item.pass)
    };
  });

  const output = {
    check_id: 'SC-RR-03',
    generated_at: new Date().toISOString(),
    parity_doc: path.relative(repoRoot, parityDocPath),
    parity_items_in_doc: parityRowsInDoc,
    parity_item_count: parityRowsInDoc.length,
    rows: evidenceMap,
    pass: parityRowsInDoc.length === 12 && evidenceMap.every(row => row.pass)
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
