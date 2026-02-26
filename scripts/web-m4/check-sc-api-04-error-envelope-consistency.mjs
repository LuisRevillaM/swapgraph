#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSchemaValidator,
  requestJson,
  seedMatchingScenario,
  startRuntimeHarness,
  token,
  validateWithSchema
} from '../web-m1/runtimeHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m4/sc-api-04-error-envelope-consistency-report.json');

function hasErrorEnvelopeShape(body) {
  return Boolean(body)
    && typeof body.correlation_id === 'string'
    && Boolean(body.correlation_id)
    && typeof body.error?.code === 'string'
    && Boolean(body.error.code)
    && typeof body.error?.message === 'string'
    && Boolean(body.error.message)
    && typeof body.error?.details === 'object'
    && body.error.details !== null
    && !Array.isArray(body.error.details);
}

async function callCase({ runtime, ajv, id, method, pathName, actor, scopes, body }) {
  const response = await requestJson({
    baseUrl: runtime.baseUrl,
    method,
    path: pathName,
    actor,
    scopes,
    body
  });

  const validation = validateWithSchema(ajv, 'ErrorResponse.schema.json', response.body);
  const pass = response.status >= 400 && validation.pass && hasErrorEnvelopeShape(response.body);

  return {
    id,
    status: response.status,
    error_code: response.body?.error?.code ?? null,
    error_message: response.body?.error?.message ?? null,
    correlation_id: response.body?.correlation_id ?? null,
    schema_valid: validation.pass,
    schema_errors: validation.errors,
    has_required_error_fields: hasErrorEnvelopeShape(response.body),
    pass
  };
}

async function acceptProposalForBoth({ runtime, proposalId, actorA, actorB }) {
  const acceptA = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: `/cycle-proposals/${encodeURIComponent(proposalId)}/accept`,
    actor: actorA,
    scopes: ['commits:write'],
    idempotencyKey: token('accept_a'),
    body: { proposal_id: proposalId }
  });
  if (acceptA.status !== 200) throw new Error(`accept A failed: ${JSON.stringify(acceptA.body)}`);

  const acceptB = await requestJson({
    baseUrl: runtime.baseUrl,
    method: 'POST',
    path: `/cycle-proposals/${encodeURIComponent(proposalId)}/accept`,
    actor: actorB,
    scopes: ['commits:write'],
    idempotencyKey: token('accept_b'),
    body: { proposal_id: proposalId }
  });
  if (acceptB.status !== 200) throw new Error(`accept B failed: ${JSON.stringify(acceptB.body)}`);
}

async function main() {
  const runtime = await startRuntimeHarness();
  try {
    const ajv = await loadSchemaValidator();
    const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });
    await acceptProposalForBoth({
      runtime,
      proposalId: seeded.proposalId,
      actorA: seeded.actorA,
      actorB: seeded.actorB
    });

    const deadline = '2026-02-24T18:00:00.000Z';
    const outsider = { type: 'user', id: token('outsider') };

    const startAsUser = await callCase({
      runtime,
      ajv,
      id: 'start_forbidden_for_user_actor_type',
      method: 'POST',
      pathName: `/settlement/${encodeURIComponent(seeded.proposalId)}/start`,
      actor: seeded.actorA,
      scopes: ['settlement:write'],
      body: { deposit_deadline_at: deadline }
    });

    const startAsPartner = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: `/settlement/${encodeURIComponent(seeded.proposalId)}/start`,
      actor: seeded.partner,
      scopes: ['settlement:write'],
      body: { deposit_deadline_at: deadline }
    });
    if (startAsPartner.status !== 200) {
      throw new Error(`partner start failed: ${JSON.stringify(startAsPartner.body)}`);
    }

    const beginAsUser = await callCase({
      runtime,
      ajv,
      id: 'begin_execution_forbidden_for_user_actor_type',
      method: 'POST',
      pathName: `/settlement/${encodeURIComponent(seeded.proposalId)}/begin-execution`,
      actor: seeded.actorA,
      scopes: ['settlement:write'],
      body: {}
    });

    const beginBeforeReady = await callCase({
      runtime,
      ajv,
      id: 'begin_execution_invalid_state_before_ready',
      method: 'POST',
      pathName: `/settlement/${encodeURIComponent(seeded.proposalId)}/begin-execution`,
      actor: seeded.partner,
      scopes: ['settlement:write'],
      body: {}
    });

    const completeBeforeExecuting = await callCase({
      runtime,
      ajv,
      id: 'complete_invalid_state_before_executing',
      method: 'POST',
      pathName: `/settlement/${encodeURIComponent(seeded.proposalId)}/complete`,
      actor: seeded.partner,
      scopes: ['settlement:write'],
      body: {}
    });

    const depositByOutsider = await callCase({
      runtime,
      ajv,
      id: 'deposit_confirmed_forbidden_for_non_participant',
      method: 'POST',
      pathName: `/settlement/${encodeURIComponent(seeded.proposalId)}/deposit-confirmed`,
      actor: outsider,
      scopes: ['settlement:write'],
      body: { deposit_ref: token('outsider_dep') }
    });

    const cases = [
      startAsUser,
      beginAsUser,
      beginBeforeReady,
      completeBeforeExecuting,
      depositByOutsider
    ];

    const output = {
      check_id: 'SC-API-04',
      generated_at: new Date().toISOString(),
      runtime_base_url: runtime.baseUrl,
      case_count: cases.length,
      cases,
      pass: cases.every(row => row.pass)
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
