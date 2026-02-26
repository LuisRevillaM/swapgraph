import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadSchemaValidator,
  requestJson,
  seedMatchingScenario,
  settleProposalToReceipt,
  startRuntimeHarness,
  validateWithSchema
} from '../../../scripts/web-m1/runtimeHarness.mjs';

test('runtime read surfaces conform to core schemas', async () => {
  const runtime = await startRuntimeHarness();
  const ajv = await loadSchemaValidator();

  try {
    const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });
    await settleProposalToReceipt({
      baseUrl: runtime.baseUrl,
      proposalId: seeded.proposalId,
      actorA: seeded.actorA,
      actorB: seeded.actorB,
      partner: seeded.partner
    });

    const intents = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/swap-intents',
      actor: seeded.actorA,
      scopes: ['swap_intents:read']
    });
    assert.equal(intents.status, 200);
    assert.equal(validateWithSchema(ajv, 'SwapIntentListResponse.schema.json', intents.body).pass, true);

    const proposals = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/cycle-proposals',
      actor: seeded.actorA,
      scopes: ['cycle_proposals:read']
    });
    assert.equal(proposals.status, 200);
    assert.equal(validateWithSchema(ajv, 'CycleProposalListResponse.schema.json', proposals.body).pass, true);

    const status = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: `/settlement/${encodeURIComponent(seeded.proposalId)}/status`,
      actor: seeded.actorA,
      scopes: ['settlement:read']
    });
    assert.equal(status.status, 200);
    assert.equal(validateWithSchema(ajv, 'SettlementStatusGetResponse.schema.json', status.body).pass, true);

    const receipt = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: `/receipts/${encodeURIComponent(seeded.proposalId)}`,
      actor: seeded.actorA,
      scopes: ['receipts:read']
    });
    assert.equal(receipt.status, 200);
    assert.equal(validateWithSchema(ajv, 'SwapReceiptGetResponse.schema.json', receipt.body).pass, true);
  } finally {
    await runtime.close();
  }
});
