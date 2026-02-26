#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MarketplaceApiClient } from '../../client/marketplace/src/api/apiClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m2/sc-rl-02-retry-backoff-report.json');

function response({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'x-correlation-id': `corr_${status}` }),
    text: async () => JSON.stringify(body)
  };
}

function buildIntent(id) {
  return {
    id,
    actor: { type: 'user', id: 'u_retry' },
    offer: [
      {
        platform: 'steam',
        app_id: 730,
        context_id: 2,
        asset_id: 'asset_retry',
        metadata: { value_usd: 120 }
      }
    ],
    want_spec: {
      type: 'set',
      any_of: [
        {
          type: 'category',
          platform: 'steam',
          app_id: 730,
          category: 'knife',
          constraints: { acceptable_wear: ['MW'] }
        }
      ]
    },
    value_band: { min_usd: 90, max_usd: 150, pricing_source: 'market_median' },
    trust_constraints: { max_cycle_length: 3, min_counterparty_reliability: 0 },
    time_constraints: { expires_at: '2027-12-31T00:00:00.000Z', urgency: 'normal' },
    settlement_preferences: { require_escrow: true }
  };
}

async function main() {
  const calls = [];
  const retries = [];
  let attempt = 0;
  const fixedIdempotencyKey = 'retry_case_idem_key';

  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      attempt += 1;
      calls.push({
        attempt,
        at_ms: Date.now(),
        url,
        method: init.method,
        idempotency_key: init.headers['idempotency-key'] ?? null
      });

      if (attempt <= 2) {
        return response({
          status: 503,
          body: {
            error: {
              code: 'UPSTREAM_UNAVAILABLE',
              message: 'temporary outage'
            }
          }
        });
      }

      return response({
        status: 200,
        body: { intent: buildIntent('intent_retry') }
      });
    },
    getActorContext: () => ({
      actorType: 'user',
      actorId: 'u_retry',
      scopes: ['swap_intents:write']
    }),
    onRetry: retry => {
      retries.push({
        attempt: retry.attempt,
        delay_ms: retry.delayMs,
        observed_at_ms: Date.now()
      });
    }
  });

  await client.createIntent({
    intent: buildIntent('intent_retry'),
    idempotencyKey: fixedIdempotencyKey
  });

  const intervals = [];
  for (let idx = 1; idx < calls.length; idx += 1) {
    intervals.push(calls[idx].at_ms - calls[idx - 1].at_ms);
  }

  const pass = calls.length === 3
    && retries.length === 2
    && retries[0].delay_ms === 120
    && retries[1].delay_ms === 240
    && calls.every(call => call.idempotency_key === fixedIdempotencyKey)
    && intervals[0] >= 100
    && intervals[1] >= 220;

  const output = {
    check_id: 'SC-RL-02',
    generated_at: new Date().toISOString(),
    expected_retry_delays_ms: [120, 240],
    retries,
    calls,
    intervals_ms: intervals,
    pass
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
