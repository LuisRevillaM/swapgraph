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
const outPath = path.join(repoRoot, 'artifacts/web-m2/sc-api-03-idempotency-report.json');

async function runCreateReplayCase({ runtime, actor, intentId }) {
  const key = token('idem_create');
  const payloadA = buildIntentPayload({
    intentId,
    actorId: actor.id,
    offerAssetId: token('create_offer'),
    wantAssetId: token('create_want'),
    valueUsd: 150
  });

  const first = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: '/swap-intents',
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: payloadA
  });

  const replay = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: '/swap-intents',
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: payloadA
  });

  const payloadMismatch = buildIntentPayload({
    intentId,
    actorId: actor.id,
    offerAssetId: token('create_offer_alt'),
    wantAssetId: token('create_want_alt'),
    valueUsd: 215
  });

  const mismatch = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: '/swap-intents',
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: payloadMismatch
  });

  return {
    id: 'create_intent_replay',
    pass: first.status === 200
      && replay.status === 200
      && mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
    first_status: first.status,
    replay_status: replay.status,
    mismatch_status: mismatch.status,
    mismatch_code: mismatch.body?.error?.code ?? null,
    replay_intent_id_equal: first.body?.intent?.id === replay.body?.intent?.id
  };
}

async function runUpdateReplayCase({ runtime, actor, intentId }) {
  const key = token('idem_update');
  const payloadA = buildIntentPayload({
    intentId,
    actorId: actor.id,
    offerAssetId: token('update_offer'),
    wantAssetId: token('update_want'),
    valueUsd: 190
  });

  const first = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'PATCH',
    path: `/swap-intents/${encodeURIComponent(intentId)}`,
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: payloadA
  });

  const replay = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'PATCH',
    path: `/swap-intents/${encodeURIComponent(intentId)}`,
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: payloadA
  });

  const payloadMismatch = buildIntentPayload({
    intentId,
    actorId: actor.id,
    offerAssetId: token('update_offer_alt'),
    wantAssetId: token('update_want_alt'),
    valueUsd: 275
  });

  const mismatch = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'PATCH',
    path: `/swap-intents/${encodeURIComponent(intentId)}`,
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: payloadMismatch
  });

  return {
    id: 'update_intent_replay',
    pass: first.status === 200
      && replay.status === 200
      && mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
    first_status: first.status,
    replay_status: replay.status,
    mismatch_status: mismatch.status,
    mismatch_code: mismatch.body?.error?.code ?? null,
    replay_intent_id_equal: first.body?.intent?.id === replay.body?.intent?.id
  };
}

async function runCancelReplayCase({ runtime, actor, intentId }) {
  const key = token('idem_cancel');

  const first = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: `/swap-intents/${encodeURIComponent(intentId)}/cancel`,
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: {}
  });

  const replay = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: `/swap-intents/${encodeURIComponent(intentId)}/cancel`,
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: {}
  });

  const mismatch = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: `/swap-intents/${encodeURIComponent(intentId)}/cancel`,
    actor,
    scopes: ['swap_intents:write'],
    idempotencyKey: key,
    body: { reason: 'user_initiated' }
  });

  return {
    id: 'cancel_intent_replay',
    pass: first.status === 200
      && replay.status === 200
      && mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
    first_status: first.status,
    replay_status: replay.status,
    mismatch_status: mismatch.status,
    mismatch_code: mismatch.body?.error?.code ?? null,
    replay_cancelled_status_equal: first.body?.status === replay.body?.status
  };
}

async function main() {
  const runtime = await startRuntimeHarness();

  try {
    const actor = { type: 'user', id: token('idem_actor') };
    const intentId = token('idem_intent');

    const seedPayload = buildIntentPayload({
      intentId,
      actorId: actor.id,
      offerAssetId: token('seed_offer'),
      wantAssetId: token('seed_want'),
      valueUsd: 140
    });

    const seed = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey: token('seed_create'),
      body: seedPayload
    });

    if (seed.status !== 200) {
      throw new Error(`seed intent failed: ${JSON.stringify(seed.body)}`);
    }

    const cases = [
      await runCreateReplayCase({ runtime, actor, intentId: token('idem_create_intent') }),
      await runUpdateReplayCase({ runtime, actor, intentId }),
      await runCancelReplayCase({ runtime, actor, intentId })
    ];

    const output = {
      check_id: 'SC-API-03',
      generated_at: new Date().toISOString(),
      runtime_base_url: runtime.baseUrl,
      case_count: cases.length,
      cases,
      pass: cases.every(testCase => testCase.pass)
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
