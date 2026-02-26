#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  requestJson,
  seedMatchingScenario,
  startRuntimeHarness,
  token
} from '../web-m1/runtimeHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m6/sc-api-02-auth-scope-conformance-report.json');

function casePass(row) {
  return row.status === row.expected_status
    && (row.expected_error_code ? row.error_code === row.expected_error_code : true);
}

async function runCase({
  baseUrl,
  id,
  actor,
  scopes,
  method,
  routePath,
  body,
  expectedStatus,
  expectedErrorCode = null
}) {
  const response = await requestJson({
    baseUrl,
    method,
    path: routePath,
    actor,
    scopes,
    body,
    idempotencyKey: method === 'POST' ? token(`sc_api_02_${id}`) : null
  });

  return {
    id,
    method,
    path: routePath,
    scopes,
    status: response.status,
    expected_status: expectedStatus,
    expected_error_code: expectedErrorCode,
    error_code: response.body?.error?.code ?? null,
    correlation_id: response.headers?.correlationId ?? null,
    pass: casePass({
      status: response.status,
      expected_status: expectedStatus,
      expected_error_code: expectedErrorCode,
      error_code: response.body?.error?.code ?? null
    })
  };
}

async function main() {
  const previousAuthz = process.env.AUTHZ_ENFORCE;
  process.env.AUTHZ_ENFORCE = '1';
  const runtime = await startRuntimeHarness();
  const checks = [];

  try {
    const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });

    checks.push(await runCase({
      baseUrl: runtime.baseUrl,
      id: 'swap_intents_read_missing_scope',
      actor: seeded.actorA,
      scopes: ['settlement:read'],
      method: 'GET',
      routePath: '/swap-intents',
      expectedStatus: 403,
      expectedErrorCode: 'INSUFFICIENT_SCOPE'
    }));

    checks.push(await runCase({
      baseUrl: runtime.baseUrl,
      id: 'swap_intents_read_with_scope',
      actor: seeded.actorA,
      scopes: ['swap_intents:read'],
      method: 'GET',
      routePath: '/swap-intents',
      expectedStatus: 200
    }));

    checks.push(await runCase({
      baseUrl: runtime.baseUrl,
      id: 'swap_intents_write_missing_scope',
      actor: seeded.actorA,
      scopes: ['swap_intents:read'],
      method: 'POST',
      routePath: '/swap-intents',
      body: {
        intent: {
          id: token('intent_scope'),
          actor: { type: 'user', id: seeded.actorA.id },
          offer: [
            {
              platform: 'steam',
              app_id: 730,
              context_id: 2,
              asset_id: token('asset_offer'),
              metadata: { value_usd: 120 }
            }
          ],
          want_spec: {
            type: 'set',
            any_of: [
              {
                type: 'specific_asset',
                platform: 'steam',
                asset_key: `steam:${token('asset_want')}`
              }
            ]
          },
          value_band: { min_usd: 100, max_usd: 140, pricing_source: 'market_median' },
          trust_constraints: { max_cycle_length: 3, min_counterparty_reliability: 0 },
          time_constraints: { expires_at: '2027-12-31T00:00:00.000Z', urgency: 'normal' },
          settlement_preferences: { require_escrow: true }
        }
      },
      expectedStatus: 403,
      expectedErrorCode: 'INSUFFICIENT_SCOPE'
    }));

    checks.push(await runCase({
      baseUrl: runtime.baseUrl,
      id: 'swap_intents_write_with_scope',
      actor: seeded.actorA,
      scopes: ['swap_intents:write'],
      method: 'POST',
      routePath: '/swap-intents',
      body: {
        intent: {
          id: token('intent_scope_ok'),
          actor: { type: 'user', id: seeded.actorA.id },
          offer: [
            {
              platform: 'steam',
              app_id: 730,
              context_id: 2,
              asset_id: token('asset_offer_ok'),
              metadata: { value_usd: 121 }
            }
          ],
          want_spec: {
            type: 'set',
            any_of: [
              {
                type: 'specific_asset',
                platform: 'steam',
                asset_key: `steam:${token('asset_want_ok')}`
              }
            ]
          },
          value_band: { min_usd: 100, max_usd: 145, pricing_source: 'market_median' },
          trust_constraints: { max_cycle_length: 3, min_counterparty_reliability: 0 },
          time_constraints: { expires_at: '2027-12-31T00:00:00.000Z', urgency: 'normal' },
          settlement_preferences: { require_escrow: true }
        }
      },
      expectedStatus: 200
    }));

    checks.push(await runCase({
      baseUrl: runtime.baseUrl,
      id: 'proposal_accept_missing_scope',
      actor: seeded.actorA,
      scopes: ['settlement:write'],
      method: 'POST',
      routePath: `/cycle-proposals/${encodeURIComponent(seeded.proposalId)}/accept`,
      body: { proposal_id: seeded.proposalId },
      expectedStatus: 403,
      expectedErrorCode: 'INSUFFICIENT_SCOPE'
    }));

    checks.push(await runCase({
      baseUrl: runtime.baseUrl,
      id: 'proposal_accept_with_scope',
      actor: seeded.actorA,
      scopes: ['commits:write'],
      method: 'POST',
      routePath: `/cycle-proposals/${encodeURIComponent(seeded.proposalId)}/accept`,
      body: { proposal_id: seeded.proposalId },
      expectedStatus: 200
    }));

    const output = {
      check_id: 'SC-API-02',
      generated_at: new Date().toISOString(),
      runtime_base_url: runtime.baseUrl,
      case_count: checks.length,
      checks,
      pass: checks.every(row => row.pass)
    };

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

    if (!output.pass) {
      process.stderr.write(JSON.stringify(output, null, 2) + '\n');
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    if (previousAuthz === undefined) delete process.env.AUTHZ_ENFORCE;
    else process.env.AUTHZ_ENFORCE = previousAuthz;
    await runtime.close();
  }
}

main();
