#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import {
  actorHeaders,
  requestJson,
  startRuntimeApi,
  stopRuntimeApi
} from './runtimeApiHarness.mjs';

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runJourney(baseURL, journeyIndex) {
  const actorId = 'u1';
  const correlationSeed = `${Date.now()}-${journeyIndex}`;
  const sessionId = `journey_${correlationSeed}`;
  const startedAt = Date.now();
  const events = [];

  const mark = name => {
    events.push({
      name,
      timestamp_iso8601: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt
    });
  };

  const intentId = `intent_ios_m2_${correlationSeed}`;

  mark('items_screen_viewed');
  const projection = await requestJson(baseURL, '/product-projections/inventory-awakening?limit=12', {
    headers: actorHeaders('user', actorId)
  });
  if (projection.status !== 200) {
    throw new Error(`projection failed: ${JSON.stringify(projection.body)}`);
  }

  mark('composer_opened');
  const createIntent = await requestJson(baseURL, '/swap-intents', {
    method: 'POST',
    headers: {
      ...actorHeaders('user', actorId),
      'Idempotency-Key': `sc-ux-01-create-${sessionId}`
    },
    body: {
      intent: {
        id: intentId,
        actor: { type: 'user', id: actorId },
        offer: [{ platform: 'steam', app_id: 730, context_id: 2, asset_id: `asset_ux_${journeyIndex}` }],
        want_spec: {
          type: 'set',
          any_of: [
            {
              type: 'category',
              platform: 'steam',
              app_id: 730,
              category: 'knife',
              constraints: {
                acceptable_wear: ['MW', 'FT']
              }
            }
          ]
        },
        value_band: {
          min_usd: 0,
          max_usd: 50,
          pricing_source: 'market_median'
        },
        trust_constraints: {
          max_cycle_length: 3,
          min_counterparty_reliability: 0
        },
        time_constraints: {
          expires_at: '2026-03-15T00:00:00Z',
          urgency: 'normal'
        },
        settlement_preferences: {
          require_escrow: true
        }
      }
    }
  });
  if (createIntent.status !== 200) {
    throw new Error(`create intent failed: ${JSON.stringify(createIntent.body)}`);
  }

  mark('intent_created');
  const intents = await requestJson(baseURL, '/swap-intents', {
    headers: actorHeaders('user', actorId)
  });
  if (intents.status !== 200) {
    throw new Error(`list intents failed: ${JSON.stringify(intents.body)}`);
  }

  const hasIntent = (intents.body?.intents ?? []).some(intent => intent.id === intentId);
  if (!hasIntent) {
    throw new Error(`newly created intent ${intentId} missing from list`);
  }

  mark('intents_watching_visible');

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  return {
    session_id: sessionId,
    actor_id: actorId,
    intent_id: intentId,
    elapsed_seconds: elapsedSeconds,
    events
  };
}

async function main() {
  const port = 3600 + Math.floor(Math.random() * 200);
  const stateFile = path.join(os.tmpdir(), `ios-m2-sc-ux-01-${Date.now()}.json`);
  const journeyCount = 5;

  let runtime;
  try {
    runtime = await startRuntimeApi({ port, stateFile });

    const seed = await requestJson(runtime.baseURL, '/dev/seed/m5', {
      method: 'POST',
      body: {
        reset: true,
        partner_id: 'partner_demo'
      }
    });
    if (seed.status !== 200) {
      throw new Error(`seed failed: ${JSON.stringify(seed.body)}`);
    }

    const traces = [];
    for (let i = 0; i < journeyCount; i += 1) {
      // Keep execution sequential to minimize timing variance.
      traces.push(await runJourney(runtime.baseURL, i));
    }

    const elapsedValues = traces.map(trace => trace.elapsed_seconds);
    const medianSeconds = median(elapsedValues);
    const overall = medianSeconds !== null && medianSeconds < 60;

    const report = {
      check_id: 'SC-UX-01',
      overall,
      objective: 'Journey J1 first intent median under 60 seconds',
      journey_count: journeyCount,
      median_elapsed_seconds: medianSeconds,
      threshold_seconds: 60,
      traces
    };

    if (!overall) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(2);
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      check_id: 'SC-UX-01',
      overall: false,
      error: String(error),
      logs: runtime?.getLogs?.() ?? null
    };
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  } finally {
    if (runtime?.child) {
      await stopRuntimeApi(runtime.child);
    }
  }
}

await main();
