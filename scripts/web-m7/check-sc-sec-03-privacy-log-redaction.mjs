#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactAnalyticsEvent } from '../../client/marketplace/src/features/security/storagePolicy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const bootstrapPath = path.join(repoRoot, 'client/marketplace/src/app/bootstrap.mjs');
const policyPath = path.join(repoRoot, 'client/marketplace/src/features/security/storagePolicy.mjs');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-sec-03-privacy-log-redaction-report.json');

function main() {
  const redacted = redactAnalyticsEvent({
    event_name: 'marketplace.push_routed',
    payload: {
      proposal_id: 'proposal_1',
      cycle_id: 'cycle_1',
      csrf_token: 'token_abc',
      channel: 'proposal',
      source: 'window_event'
    },
    occurred_at: '2026-02-24T12:00:00.000Z'
  });

  const bootstrapSource = readFileSync(bootstrapPath, 'utf8');
  const policySource = readFileSync(policyPath, 'utf8');

  const checklist = [
    {
      id: 'analytics_sink_uses_redaction_before_logging',
      pass: /redactAnalyticsEvent\(event\)/.test(bootstrapSource)
    },
    {
      id: 'redactor_masks_id_like_fields',
      pass: redacted.payload.proposal_id === '[redacted]' && redacted.payload.cycle_id === '[redacted]'
    },
    {
      id: 'redactor_masks_token_like_fields',
      pass: redacted.payload.csrf_token === '[redacted]'
    },
    {
      id: 'privacy_policy_rule_defined',
      pass: /ID_FIELD_PATTERN/.test(policySource)
    }
  ];

  const output = {
    check_id: 'SC-SEC-03',
    generated_at: new Date().toISOString(),
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
