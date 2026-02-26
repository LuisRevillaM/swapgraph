#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSchemaValidator,
  requestJson,
  seedMatchingScenario,
  settleProposalToReceipt,
  startRuntimeHarness,
  validateWithSchema
} from './runtimeHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m1/sc-api-01-contract-report.json');

function pushResult(results, entry) {
  results.push(entry);
}

async function main() {
  const runtime = await startRuntimeHarness();
  const ajv = await loadSchemaValidator();
  const results = [];

  try {
    const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });
    await settleProposalToReceipt({
      baseUrl: runtime.baseUrl,
      proposalId: seeded.proposalId,
      actorA: seeded.actorA,
      actorB: seeded.actorB,
      partner: seeded.partner
    });

    const health = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/healthz'
    });

    pushResult(results, {
      endpoint: 'GET /healthz',
      status: health.status,
      pass: health.status === 200
        && health.body?.ok === true
        && typeof health.body?.store_backend === 'string'
        && typeof health.body?.state === 'object',
      errors: health.status === 200 ? [] : [{ message: 'healthz status not 200' }]
    });

    const intentList = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/swap-intents',
      actor: seeded.actorA,
      scopes: ['swap_intents:read']
    });

    const intentSchema = validateWithSchema(ajv, 'SwapIntentListResponse.schema.json', intentList.body);
    pushResult(results, {
      endpoint: 'GET /swap-intents',
      status: intentList.status,
      schema: 'SwapIntentListResponse.schema.json',
      pass: intentList.status === 200 && intentSchema.pass,
      errors: intentSchema.errors
    });

    const proposals = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/cycle-proposals',
      actor: seeded.actorA,
      scopes: ['cycle_proposals:read']
    });

    const proposalSchema = validateWithSchema(ajv, 'CycleProposalListResponse.schema.json', proposals.body);
    pushResult(results, {
      endpoint: 'GET /cycle-proposals',
      status: proposals.status,
      schema: 'CycleProposalListResponse.schema.json',
      pass: proposals.status === 200 && proposalSchema.pass,
      errors: proposalSchema.errors
    });

    const runGet = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: `/marketplace/matching/runs/${encodeURIComponent(seeded.runId)}`,
      actor: seeded.partner,
      scopes: ['settlement:read']
    });

    const runSchema = validateWithSchema(ajv, 'MarketplaceMatchingRunGetResponse.schema.json', runGet.body);
    pushResult(results, {
      endpoint: 'GET /marketplace/matching/runs/{run_id}',
      status: runGet.status,
      schema: 'MarketplaceMatchingRunGetResponse.schema.json',
      pass: runGet.status === 200 && runSchema.pass,
      errors: runSchema.errors
    });

    const timeline = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: `/settlement/${encodeURIComponent(seeded.proposalId)}/status`,
      actor: seeded.actorA,
      scopes: ['settlement:read']
    });

    const timelineSchema = validateWithSchema(ajv, 'SettlementStatusGetResponse.schema.json', timeline.body);
    pushResult(results, {
      endpoint: 'GET /settlement/{cycle_id}/status',
      status: timeline.status,
      schema: 'SettlementStatusGetResponse.schema.json',
      pass: timeline.status === 200 && timelineSchema.pass,
      errors: timelineSchema.errors
    });

    const receipt = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: `/receipts/${encodeURIComponent(seeded.proposalId)}`,
      actor: seeded.actorA,
      scopes: ['receipts:read']
    });

    const receiptSchema = validateWithSchema(ajv, 'SwapReceiptGetResponse.schema.json', receipt.body);
    pushResult(results, {
      endpoint: 'GET /receipts/{cycle_id}',
      status: receipt.status,
      schema: 'SwapReceiptGetResponse.schema.json',
      pass: receipt.status === 200 && receiptSchema.pass,
      errors: receiptSchema.errors
    });

    const output = {
      check_id: 'SC-API-01',
      generated_at: new Date().toISOString(),
      runtime_base_url: runtime.baseUrl,
      result_count: results.length,
      results,
      pass: results.every(result => result.pass)
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
