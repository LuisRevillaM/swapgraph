#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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

function createErrorValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schemaPath = repoPath('docs/spec/schemas/ErrorResponse.schema.json');
  const schema = readJson(schemaPath);
  const validate = ajv.compile(schema);
  return payload => ({
    ok: validate(payload),
    errors: validate.errors ?? []
  });
}

function checkErrorCase({
  name,
  response,
  expectedStatus,
  expectedCode,
  validateError
}) {
  const schemaCheck = validateError(response.body);
  const pass = response.status === expectedStatus
    && response.body?.error?.code === expectedCode
    && schemaCheck.ok;

  return {
    scenario: name,
    expected_status: expectedStatus,
    expected_error_code: expectedCode,
    actual_status: response.status,
    actual_error_code: response.body?.error?.code ?? null,
    schema_valid: schemaCheck.ok,
    schema_errors: schemaCheck.errors,
    response_body: response.body,
    pass
  };
}

async function main() {
  const port = 3600 + Math.floor(Math.random() * 200);
  const stateFile = path.join(os.tmpdir(), `ios-m4-sc-api-04-${Date.now()}.json`);
  const validateError = createErrorValidator();

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

    const proposals = await requestJson(runtime.baseURL, '/cycle-proposals', {
      headers: actorHeaders('user', 'u5')
    });
    if (proposals.status !== 200) {
      throw new Error(`proposal list failed: ${JSON.stringify(proposals.body)}`);
    }

    const proposal = proposals.body?.proposals?.[0];
    if (!proposal) {
      throw new Error('no proposal available for API-04 checks');
    }

    const cycleId = proposal.id;
    const participants = proposal.participants ?? [];
    if (participants.length === 0) {
      throw new Error('proposal has no participants');
    }

    for (const participant of participants) {
      const actorId = participant?.actor?.id;
      if (!actorId) continue;

      const accepted = await requestJson(runtime.baseURL, `/cycle-proposals/${cycleId}/accept`, {
        method: 'POST',
        headers: {
          ...actorHeaders('user', actorId),
          'Idempotency-Key': `sc-api-04-accept-${cycleId}-${actorId}`
        },
        body: {
          proposal_id: cycleId,
          occurred_at: '2026-02-24T10:00:00Z'
        }
      });

      if (accepted.status !== 200) {
        throw new Error(`accept failed for actor ${actorId}: ${JSON.stringify(accepted.body)}`);
      }
    }

    const start = await requestJson(runtime.baseURL, `/settlement/${cycleId}/start`, {
      method: 'POST',
      headers: actorHeaders('partner', 'partner_demo'),
      body: {
        deposit_deadline_at: '2026-02-25T08:00:00Z'
      }
    });
    if (start.status !== 200) {
      throw new Error(`settlement start failed: ${JSON.stringify(start.body)}`);
    }

    const beginAsUser = await requestJson(runtime.baseURL, `/settlement/${cycleId}/begin-execution`, {
      method: 'POST',
      headers: actorHeaders('user', participants[0]?.actor?.id ?? 'u5'),
      body: {}
    });

    const completeBeforeExecution = await requestJson(runtime.baseURL, `/settlement/${cycleId}/complete`, {
      method: 'POST',
      headers: actorHeaders('partner', 'partner_demo'),
      body: {}
    });

    const depositByOutsider = await requestJson(runtime.baseURL, `/settlement/${cycleId}/deposit-confirmed`, {
      method: 'POST',
      headers: actorHeaders('user', 'outsider_1'),
      body: {
        deposit_ref: 'dep_invalid'
      }
    });

    const checks = [
      checkErrorCase({
        name: 'begin_execution_forbidden_for_user',
        response: beginAsUser,
        expectedStatus: 403,
        expectedCode: 'FORBIDDEN',
        validateError
      }),
      checkErrorCase({
        name: 'complete_conflict_before_executing_state',
        response: completeBeforeExecution,
        expectedStatus: 409,
        expectedCode: 'CONFLICT',
        validateError
      }),
      checkErrorCase({
        name: 'deposit_confirmed_constraint_violation_for_non_participant',
        response: depositByOutsider,
        expectedStatus: 400,
        expectedCode: 'CONSTRAINT_VIOLATION',
        validateError
      })
    ];

    const overall = checks.every(row => row.pass);
    const report = {
      check_id: 'SC-API-04',
      overall,
      cycle_id: cycleId,
      check_count: checks.length,
      checks
    };

    if (!overall) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(2);
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      check_id: 'SC-API-04',
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
