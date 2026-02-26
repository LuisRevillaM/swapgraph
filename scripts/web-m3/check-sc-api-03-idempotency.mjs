#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestJson, seedMatchingScenario, startRuntimeHarness, token } from '../web-m1/runtimeHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m3/sc-api-03-idempotency-report.json');

async function runAcceptReplayCase(runtime) {
  const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });
  const key = token('proposal_accept_replay');
  const pathName = `/cycle-proposals/${encodeURIComponent(seeded.proposalId)}/accept`;

  const first = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: pathName,
    actor: seeded.actorA,
    scopes: ['commits:write'],
    idempotencyKey: key,
    body: { proposal_id: seeded.proposalId }
  });

  const replay = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: pathName,
    actor: seeded.actorA,
    scopes: ['commits:write'],
    idempotencyKey: key,
    body: { proposal_id: seeded.proposalId }
  });

  const mismatch = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: pathName,
    actor: seeded.actorA,
    scopes: ['commits:write'],
    idempotencyKey: key,
    body: { proposal_id: `${seeded.proposalId}_mismatch` }
  });

  return {
    id: 'proposal_accept_replay',
    pass: first.status === 200
      && replay.status === 200
      && mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
    first_status: first.status,
    replay_status: replay.status,
    mismatch_status: mismatch.status,
    mismatch_code: mismatch.body?.error?.code ?? null,
    replay_commit_id_equal: first.body?.commit?.id === replay.body?.commit?.id
  };
}

async function runDeclineReplayCase(runtime) {
  const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });
  const key = token('proposal_decline_replay');
  const pathName = `/cycle-proposals/${encodeURIComponent(seeded.proposalId)}/decline`;

  const first = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: pathName,
    actor: seeded.actorA,
    scopes: ['commits:write'],
    idempotencyKey: key,
    body: { proposal_id: seeded.proposalId }
  });

  const replay = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: pathName,
    actor: seeded.actorA,
    scopes: ['commits:write'],
    idempotencyKey: key,
    body: { proposal_id: seeded.proposalId }
  });

  const mismatch = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: pathName,
    actor: seeded.actorA,
    scopes: ['commits:write'],
    idempotencyKey: key,
    body: { proposal_id: `${seeded.proposalId}_mismatch` }
  });

  return {
    id: 'proposal_decline_replay',
    pass: first.status === 200
      && replay.status === 200
      && mismatch.status === 409
      && mismatch.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
    first_status: first.status,
    replay_status: replay.status,
    mismatch_status: mismatch.status,
    mismatch_code: mismatch.body?.error?.code ?? null,
    replay_commit_id_equal: first.body?.commit?.id === replay.body?.commit?.id
  };
}

async function main() {
  const runtimeA = await startRuntimeHarness();
  let acceptCase;
  try {
    acceptCase = await runAcceptReplayCase(runtimeA);
  } finally {
    await runtimeA.close();
  }

  const runtimeB = await startRuntimeHarness();
  let declineCase;
  try {
    declineCase = await runDeclineReplayCase(runtimeB);
  } finally {
    await runtimeB.close();
  }

  const cases = [acceptCase, declineCase];
  const output = {
    check_id: 'SC-API-03',
    generated_at: new Date().toISOString(),
    runtime_base_urls: {
      accept_case: runtimeA.baseUrl,
      decline_case: runtimeB.baseUrl
    },
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
}

main();
