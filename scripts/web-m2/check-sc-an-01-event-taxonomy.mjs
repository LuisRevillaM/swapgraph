#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANALYTICS_EVENT_SCHEMAS,
  validateAnalyticsEvent
} from '../../client/marketplace/src/analytics/events.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m2/sc-an-01-event-taxonomy-report.json');

const samplePayloads = {
  'marketplace.tab_viewed': { tab: 'items' },
  'marketplace.route_opened': { tab: 'items', path: '/items' },
  'marketplace.api_request': { operation: 'intents.list', method: 'GET', status: 200 },
  'marketplace.api_retry': { operation: 'intents.create', attempt: 1, delay_ms: 120 },
  'marketplace.api_error': { operation: 'intents.create', code: 'NETWORK_ERROR', status: 0 },
  'marketplace.items_demand_banner_tapped': { opportunity_count: 2 },
  'marketplace.items_sort_changed': { sort: 'highest_demand' },
  'marketplace.intent_composer_opened': { mode: 'create' },
  'marketplace.intent_validation_failed': { mode: 'create', field_count: 2 },
  'marketplace.intent_submit_started': { mode: 'create', intent_id: 'intent_1' },
  'marketplace.intent_submit_succeeded': { mode: 'create', intent_id: 'intent_1', latency_ms: 420 },
  'marketplace.intent_submit_failed': { mode: 'edit', intent_id: 'intent_1', code: 'CONSTRAINT_VIOLATION', status: 400 },
  'marketplace.intent_cancel_started': { intent_id: 'intent_1' },
  'marketplace.intent_cancel_succeeded': { intent_id: 'intent_1', latency_ms: 210 },
  'marketplace.intent_cancel_failed': { intent_id: 'intent_1', code: 'NETWORK_ERROR', status: 0 }
};

function main() {
  const rows = Object.entries(samplePayloads).map(([eventName, payload]) => {
    const schema = ANALYTICS_EVENT_SCHEMAS[eventName] ?? null;
    const validation = validateAnalyticsEvent(eventName, payload);
    return {
      event_name: eventName,
      schema_present: Boolean(schema),
      sample_payload: payload,
      sample_validation_ok: validation.ok,
      sample_validation_error: validation.ok ? null : validation.error
    };
  });

  const missingSchemas = rows.filter(row => !row.schema_present).map(row => row.event_name);
  const failedSamples = rows.filter(row => !row.sample_validation_ok).map(row => row.event_name);

  const output = {
    check_id: 'SC-AN-01',
    generated_at: new Date().toISOString(),
    catalog_size: Object.keys(ANALYTICS_EVENT_SCHEMAS).length,
    expected_event_count: rows.length,
    rows,
    missing_schemas: missingSchemas,
    failed_samples: failedSamples,
    pass: missingSchemas.length === 0 && failedSamples.length === 0
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
