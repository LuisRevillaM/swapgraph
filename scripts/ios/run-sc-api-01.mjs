#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  actorHeaders,
  repoPath,
  requestJson,
  startRuntimeApi,
  stopRuntimeApi
} from './runtimeApiHarness.mjs';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function createSchemaValidator() {
  const schemasDir = repoPath('docs/spec/schemas');
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);

  for (const file of readdirSync(schemasDir).filter(file => file.endsWith('.schema.json'))) {
    ajv.addSchema(readJson(path.join(schemasDir, file)));
  }

  return {
    validate(schemaFile, payload) {
      const schemaPath = path.join(schemasDir, schemaFile);
      const schema = readJson(schemaPath);
      const validator = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
      const ok = validator(payload);
      return {
        ok,
        errors: validator.errors ?? []
      };
    }
  };
}

function assertOk(response, label) {
  if (response.status !== 200) {
    throw new Error(`${label} failed with status ${response.status}: ${JSON.stringify(response.body)}`);
  }
}

async function main() {
  const port = 3150 + Math.floor(Math.random() * 200);
  const stateFile = path.join(os.tmpdir(), `ios-m1-sc-api-01-${Date.now()}.json`);
  const validator = createSchemaValidator();

  let runtime;
  try {
    runtime = await startRuntimeApi({ port, stateFile });

    const checks = [];

    const health = await requestJson(runtime.baseURL, '/healthz');
    const healthPass = health.status === 200 && health.body?.ok === true;
    checks.push({ endpoint: '/healthz', status: health.status, pass: healthPass });
    if (!healthPass) {
      throw new Error(`health check failed: ${JSON.stringify(health.body)}`);
    }

    const seed = await requestJson(runtime.baseURL, '/dev/seed/m5', {
      method: 'POST',
      body: {
        reset: true,
        partner_id: 'partner_demo'
      }
    });
    assertOk(seed, 'seed');

    const intentId = `intent_ios_m1_${Date.now()}`;
    const createIntent = await requestJson(runtime.baseURL, '/swap-intents', {
      method: 'POST',
      headers: {
        ...actorHeaders('user', 'u1'),
        'Idempotency-Key': `sc-api-01-intent-${Date.now()}`
      },
      body: {
        intent: {
          id: intentId,
          actor: { type: 'user', id: 'u1' },
          offer: [{ platform: 'steam', app_id: 730, context_id: 2, asset_id: 'assetA' }],
          want_spec: {
            type: 'set',
            any_of: [
              {
                type: 'category',
                platform: 'steam',
                app_id: 730,
                category: 'knife'
              }
            ]
          },
          value_band: {
            min_usd: 10,
            max_usd: 100,
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
    assertOk(createIntent, 'create intent');

    const intents = await requestJson(runtime.baseURL, '/swap-intents', {
      headers: actorHeaders('user', 'u1')
    });
    assertOk(intents, 'list intents');

    const intentsSchema = validator.validate('SwapIntentListResponse.schema.json', intents.body);
    checks.push({ endpoint: '/swap-intents', status: intents.status, pass: intentsSchema.ok, schema: 'SwapIntentListResponse.schema.json', errors: intentsSchema.errors });

    const proposals = await requestJson(runtime.baseURL, '/cycle-proposals', {
      headers: actorHeaders('user', 'u1')
    });
    assertOk(proposals, 'list proposals');

    const proposalsSchema = validator.validate('CycleProposalListResponse.schema.json', proposals.body);
    checks.push({ endpoint: '/cycle-proposals', status: proposals.status, pass: proposalsSchema.ok, schema: 'CycleProposalListResponse.schema.json', errors: proposalsSchema.errors });

    const proposal = proposals.body?.proposals?.[0];
    if (!proposal) {
      throw new Error('No proposal available for settlement flow');
    }

    const cycleId = proposal.id;
    const participants = proposal.participants ?? [];

    for (const participant of participants) {
      const actorId = participant?.actor?.id;
      if (!actorId) continue;

      const accept = await requestJson(runtime.baseURL, `/cycle-proposals/${cycleId}/accept`, {
        method: 'POST',
        headers: {
          ...actorHeaders('user', actorId),
          'Idempotency-Key': `sc-api-01-accept-${cycleId}-${actorId}`
        },
        body: {
          proposal_id: cycleId,
          occurred_at: '2026-02-24T08:00:00Z'
        }
      });
      assertOk(accept, `accept ${actorId}`);
    }

    const settlementStart = await requestJson(runtime.baseURL, `/settlement/${cycleId}/start`, {
      method: 'POST',
      headers: actorHeaders('partner', 'partner_demo'),
      body: {
        deposit_deadline_at: '2026-02-25T08:00:00Z'
      }
    });
    assertOk(settlementStart, 'settlement start');

    for (const participant of participants) {
      const actorId = participant?.actor?.id;
      if (!actorId) continue;

      const deposit = await requestJson(runtime.baseURL, `/settlement/${cycleId}/deposit-confirmed`, {
        method: 'POST',
        headers: actorHeaders('user', actorId),
        body: {
          deposit_ref: `deposit_${actorId}`,
          occurred_at: '2026-02-24T08:30:00Z'
        }
      });
      assertOk(deposit, `deposit ${actorId}`);
    }

    const beginExecution = await requestJson(runtime.baseURL, `/settlement/${cycleId}/begin-execution`, {
      method: 'POST',
      headers: actorHeaders('partner', 'partner_demo'),
      body: {}
    });
    assertOk(beginExecution, 'begin execution');

    const complete = await requestJson(runtime.baseURL, `/settlement/${cycleId}/complete`, {
      method: 'POST',
      headers: actorHeaders('partner', 'partner_demo'),
      body: {}
    });
    assertOk(complete, 'complete settlement');

    const timeline = await requestJson(runtime.baseURL, `/settlement/${cycleId}/status`, {
      headers: actorHeaders('user', participants[0]?.actor?.id ?? 'u1')
    });
    assertOk(timeline, 'timeline status');

    const timelineSchema = validator.validate('SettlementStatusGetResponse.schema.json', timeline.body);
    checks.push({ endpoint: `/settlement/${cycleId}/status`, status: timeline.status, pass: timelineSchema.ok, schema: 'SettlementStatusGetResponse.schema.json', errors: timelineSchema.errors });

    const receipt = await requestJson(runtime.baseURL, `/receipts/${cycleId}`, {
      headers: actorHeaders('user', participants[0]?.actor?.id ?? 'u1')
    });
    assertOk(receipt, 'receipt');

    const receiptSchema = validator.validate('SwapReceiptGetResponse.schema.json', receipt.body);
    checks.push({ endpoint: `/receipts/${cycleId}`, status: receipt.status, pass: receiptSchema.ok, schema: 'SwapReceiptGetResponse.schema.json', errors: receiptSchema.errors });

    const overall = checks.every(check => check.pass);
    const report = {
      check_id: 'SC-API-01',
      overall,
      cycle_id: cycleId,
      checks
    };

    if (!overall) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(2);
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      check_id: 'SC-API-01',
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
