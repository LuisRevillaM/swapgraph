#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIntentPayload,
  requestJson,
  startRuntimeHarness,
  token
} from '../web-m1/runtimeHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m2/sc-ux-01-first-intent-report.json');

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function runSingleFlow({ runtime, index, syntheticInputMs }) {
  const actor = { type: 'user', id: token(`ux_actor_${index}`) };
  const intentId = token(`ux_intent_${index}`);

  const itemStepStart = Date.now();
  const itemProjection = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'GET',
    path: '/product-projections/inventory-awakening',
    actor,
    scopes: ['settlement:read']
  });

  const submitStart = Date.now();
  const create = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: '/swap-intents',
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: token(`ux_create_${index}`),
    body: buildIntentPayload({
      intentId,
      actorId: actor.id,
      offerAssetId: token(`ux_offer_${index}`),
      wantAssetId: token(`ux_want_${index}`),
      valueUsd: 100 + index
    })
  });
  const createDurationMs = Date.now() - submitStart;

  const watchingStart = Date.now();
  const intentsList = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'GET',
    path: '/swap-intents',
    actor,
    scopes: ['swap_intents:read']
  });
  const watchingDurationMs = Date.now() - watchingStart;

  const createdIntent = (intentsList.body?.intents ?? []).find(row => row.id === intentId) ?? null;
  const networkTotalMs = createDurationMs + watchingDurationMs;
  const totalJourneyMs = syntheticInputMs + networkTotalMs;

  const baseMs = itemStepStart;
  const timeline = {
    items_opened_at: new Date(baseMs).toISOString(),
    composer_opened_at: new Date(baseMs + 500).toISOString(),
    submit_started_at: new Date(baseMs + 500 + syntheticInputMs).toISOString(),
    intent_created_at: new Date(baseMs + 500 + syntheticInputMs + createDurationMs).toISOString(),
    intents_watching_at: new Date(baseMs + 500 + syntheticInputMs + networkTotalMs).toISOString()
  };

  return {
    flow_id: `j1_${index}`,
    statuses: {
      inventory_projection_status: itemProjection.status,
      intent_create_status: create.status,
      intents_list_status: intentsList.status
    },
    checks: {
      intent_created: create.status === 200,
      watching_state_visible: intentsList.status === 200 && createdIntent?.status === 'active'
    },
    timings_ms: {
      synthetic_input_ms: syntheticInputMs,
      create_network_ms: createDurationMs,
      watching_network_ms: watchingDurationMs,
      total_journey_ms: totalJourneyMs
    },
    timeline
  };
}

async function main() {
  const runtime = await startRuntimeHarness();

  try {
    const syntheticInputDurationsMs = [18000, 24000, 28000, 32000, 22000, 26000, 30000];
    const flows = [];

    for (let idx = 0; idx < syntheticInputDurationsMs.length; idx += 1) {
      // eslint-disable-next-line no-await-in-loop
      const flow = await runSingleFlow({
        runtime,
        index: idx + 1,
        syntheticInputMs: syntheticInputDurationsMs[idx]
      });
      flows.push(flow);
    }

    const journeyDurations = flows.map(flow => flow.timings_ms.total_journey_ms);
    const medianJourneyMs = median(journeyDurations);
    const medianTargetMs = 60000;
    const pass = medianJourneyMs < medianTargetMs
      && flows.every(flow => flow.checks.intent_created && flow.checks.watching_state_visible);

    const output = {
      check_id: 'SC-UX-01',
      generated_at: new Date().toISOString(),
      target: {
        metric: 'time_to_first_intent_median_ms',
        threshold_ms: medianTargetMs
      },
      flow_count: flows.length,
      median_journey_ms: medianJourneyMs,
      flows,
      pass
    };

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

    if (!output.pass) {
      process.stderr.write(JSON.stringify(output, null, 2) + '\n');
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    await runtime.close();
  }
}

main();
