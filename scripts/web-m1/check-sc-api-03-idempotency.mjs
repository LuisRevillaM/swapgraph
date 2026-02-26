#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIntentPayload, requestJson, startRuntimeHarness, token } from './runtimeHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m1/sc-api-03-idempotency-report.json');

async function main() {
  const runtime = await startRuntimeHarness();

  try {
    const actor = { type: 'user', id: token('replay_actor') };
    const sharedKey = token('idem_replay');

    const intentId = token('intent_replay');
    const payloadA = buildIntentPayload({
      intentId,
      actorId: actor.id,
      offerAssetId: token('offer'),
      wantAssetId: token('want'),
      valueUsd: 104
    });

    const first = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey: sharedKey,
      body: payloadA
    });

    const second = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey: sharedKey,
      body: payloadA
    });

    const payloadB = buildIntentPayload({
      intentId,
      actorId: actor.id,
      offerAssetId: token('offer_alt'),
      wantAssetId: token('want_alt'),
      valueUsd: 140
    });

    const mismatch = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey: sharedKey,
      body: payloadB
    });

    const replaySamePayloadPass = first.status === 200
      && second.status === 200
      && first.body?.intent?.id
      && first.body?.intent?.id === second.body?.intent?.id;

    const mismatchPass = mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH';

    const output = {
      check_id: 'SC-API-03',
      generated_at: new Date().toISOString(),
      runtime_base_url: runtime.baseUrl,
      cases: [
        {
          id: 'same_payload_replay',
          pass: replaySamePayloadPass,
          expected_statuses: [200, 200],
          actual_statuses: [first.status, second.status],
          first_intent_id: first.body?.intent?.id ?? null,
          second_intent_id: second.body?.intent?.id ?? null
        },
        {
          id: 'mismatch_payload_replay',
          pass: mismatchPass,
          expected_status: 409,
          actual_status: mismatch.status,
          error_code: mismatch.body?.error?.code ?? null
        }
      ]
    };

    output.pass = output.cases.every(testCase => testCase.pass);

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
