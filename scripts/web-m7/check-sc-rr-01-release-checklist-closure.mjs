#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-rr-01-release-checklist-closure-report.json');

function readArtifactPass(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return {
      exists: false,
      pass: false,
      path: relativePath
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
    return {
      exists: true,
      pass: parsed?.pass === true,
      path: relativePath
    };
  } catch {
    return {
      exists: true,
      pass: false,
      path: relativePath
    };
  }
}

function main() {
  const checklist = [
    { id: 'sc-ax-01', artifact: 'artifacts/web-m7/sc-ax-01-contrast-readability-report.json' },
    { id: 'sc-ax-02', artifact: 'artifacts/web-m7/sc-ax-02-assistive-semantics-focus-order-report.json' },
    { id: 'sc-ax-03', artifact: 'artifacts/web-m7/sc-ax-03-touch-target-baseline-report.json' },
    { id: 'sc-pf-01', artifact: 'artifacts/web-m7/sc-pf-01-startup-performance-budget-report.json' },
    { id: 'sc-pf-02', artifact: 'artifacts/web-m7/sc-pf-02-interaction-latency-budget-report.json' },
    { id: 'sc-pf-03', artifact: 'artifacts/web-m7/sc-pf-03-long-list-scroll-performance-report.json' },
    { id: 'sc-sec-01', artifact: 'artifacts/web-m7/sc-sec-01-secure-local-storage-report.json' },
    { id: 'sc-sec-02', artifact: 'artifacts/web-m7/sc-sec-02-session-auth-boundary-controls-report.json' },
    { id: 'sc-sec-03', artifact: 'artifacts/web-m7/sc-sec-03-privacy-log-redaction-report.json' },
    { id: 'reg-ux-02', artifact: 'artifacts/web-m3/sc-ux-02-proposal-decision-clarity-report.json' },
    { id: 'reg-ux-03', artifact: 'artifacts/web-m4/sc-ux-03-active-timeline-clarity-report.json' },
    { id: 'reg-ux-04', artifact: 'artifacts/web-m5/sc-ux-04-receipt-clarity-report.json' },
    { id: 'reg-an-01', artifact: 'artifacts/web-m6/sc-an-01-event-taxonomy-report.json' },
    { id: 'reg-an-02', artifact: 'artifacts/web-m3/sc-an-02-funnel-ordering-report.json' },
    { id: 'reg-rl-01', artifact: 'artifacts/web-m6/sc-rl-01-offline-read-continuity-report.json' },
    { id: 'reg-rl-03', artifact: 'artifacts/web-m6/sc-rl-03-stale-data-signaling-report.json' },
    { id: 'reg-api-01', artifact: 'artifacts/web-m1/sc-api-01-contract-report.json' },
    { id: 'reg-api-03', artifact: 'artifacts/web-m3/sc-api-03-idempotency-report.json' },
    { id: 'reg-api-04', artifact: 'artifacts/web-m4/sc-api-04-error-envelope-consistency-report.json' },
    { id: 'reg-ds-01', artifact: 'artifacts/web-m1/sc-ds-01-token-parity-report.json' },
    { id: 'reg-ds-02', artifact: 'artifacts/web-m1/sc-ds-02-readability-report.json' }
  ].map(row => {
    const result = readArtifactPass(row.artifact);
    return {
      id: row.id,
      artifact: row.artifact,
      exists: result.exists,
      pass: result.pass
    };
  });

  const output = {
    check_id: 'SC-RR-01',
    generated_at: new Date().toISOString(),
    checklist,
    pass: checklist.every(row => row.exists && row.pass)
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
