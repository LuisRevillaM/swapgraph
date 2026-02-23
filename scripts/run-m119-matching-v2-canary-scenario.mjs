import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketplaceMatchingService } from '../src/service/marketplaceMatchingService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M119';
const SCENARIO_FILE = 'fixtures/release/m119_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m119_expected.json';
const OUTPUT_FILE = 'matching_v2_canary_output.json';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableHash(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function withIsolatedMatcherEnv(overrides, fn) {
  const caseEnv = overrides ?? {};
  const matcherKeys = new Set([
    ...Object.keys(process.env).filter(key => key.startsWith('MATCHING_V2_')),
    ...Object.keys(caseEnv).filter(key => key.startsWith('MATCHING_V2_'))
  ]);
  const otherKeys = Object.keys(caseEnv).filter(key => !key.startsWith('MATCHING_V2_'));
  const managedKeys = new Set([...matcherKeys, ...otherKeys]);
  const previous = new Map();
  for (const key of managedKeys) {
    previous.set(key, process.env[key]);
    if (Object.prototype.hasOwnProperty.call(caseEnv, key)) process.env[key] = String(caseEnv[key]);
    else delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, previousValue] of previous.entries()) {
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    }
  }
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const schemaFile of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, schemaFile)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const runEndpoint = (apiManifest.endpoints ?? []).find(endpoint => endpoint.operation_id === 'marketplaceMatching.run');
if (!runEndpoint) throw new Error('missing marketplaceMatching.run endpoint in manifest');

function validateRunRequest(requestPayload) {
  const validation = validateAgainstSchemaFile(runEndpoint.request_schema, requestPayload);
  if (!validation.ok) throw new Error(`request invalid: ${JSON.stringify(validation.errors)}`);
}

function validateRunResponse(response) {
  if (response.ok) {
    const validation = validateAgainstSchemaFile(runEndpoint.response_schema, response.body);
    if (!validation.ok) throw new Error(`response invalid: ${JSON.stringify(validation.errors)}`);
    return;
  }

  const errValidation = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
  if (!errValidation.ok) throw new Error(`error response invalid: ${JSON.stringify(errValidation.errors)}`);
}

function createSeededStore({ seedState }) {
  const store = new JsonStateStore({ filePath: path.join(outDir, 'store_m119.json') });
  store.load();
  for (const [key, value] of Object.entries(seedState ?? {})) {
    store.state[key] = clone(value);
  }
  return store;
}

function assertStepExpectations({ step, run, decision }) {
  const expect = step?.expect ?? {};
  if (expect.primary_engine !== undefined) {
    assert.equal(decision?.primary_engine, expect.primary_engine, `primary_engine mismatch for step=${step.label}`);
  }
  if (expect.canary_selected !== undefined) {
    assert.equal(Boolean(decision?.canary_selected), Boolean(expect.canary_selected), `canary_selected mismatch for step=${step.label}`);
  }
  if (expect.routed_to_v2 !== undefined) {
    assert.equal(Boolean(decision?.routed_to_v2), Boolean(expect.routed_to_v2), `routed_to_v2 mismatch for step=${step.label}`);
  }
  if (expect.fallback_to_v1 !== undefined) {
    assert.equal(Boolean(decision?.fallback_to_v1), Boolean(expect.fallback_to_v1), `fallback_to_v1 mismatch for step=${step.label}`);
  }
  if (expect.skipped_reason !== undefined) {
    assert.equal(decision?.skipped_reason ?? null, expect.skipped_reason, `skipped_reason mismatch for step=${step.label}`);
  }
  if (expect.v2_error !== undefined) {
    assert.equal(Boolean(decision?.v2?.error), Boolean(expect.v2_error), `v2_error mismatch for step=${step.label}`);
  }
  if (expect.rollback_triggered !== undefined) {
    assert.equal(Boolean(decision?.rollback?.triggered), Boolean(expect.rollback_triggered), `rollback_triggered mismatch for step=${step.label}`);
  }
  if (expect.rollback_active_after !== undefined) {
    assert.equal(Boolean(decision?.rollback?.active_after), Boolean(expect.rollback_active_after), `rollback_active_after mismatch for step=${step.label}`);
  }
  if (expect.rollback_reason_code_after !== undefined) {
    assert.equal(decision?.rollback?.reason_code_after ?? null, expect.rollback_reason_code_after, `rollback_reason_code_after mismatch for step=${step.label}`);
  }
  if (expect.sample_summary_samples_count !== undefined) {
    assert.equal(
      Number(decision?.sample_summary?.samples_count ?? -1),
      Number(expect.sample_summary_samples_count),
      `sample_summary_samples_count mismatch for step=${step.label}`
    );
  }
  if (expect.sample_summary_reason_code !== undefined) {
    assert.equal(
      decision?.sample_summary?.reason_code ?? null,
      expect.sample_summary_reason_code,
      `sample_summary_reason_code mismatch for step=${step.label}`
    );
  }
  if (expect.sample_summary_error_rate_bps !== undefined) {
    assert.equal(
      Number(decision?.sample_summary?.rates_bps?.error_rate_bps ?? -1),
      Number(expect.sample_summary_error_rate_bps),
      `sample_summary_error_rate_bps mismatch for step=${step.label}`
    );
  }
  if (expect.sample_summary_timeout_rate_bps !== undefined) {
    assert.equal(
      Number(decision?.sample_summary?.rates_bps?.timeout_rate_bps ?? -1),
      Number(expect.sample_summary_timeout_rate_bps),
      `sample_summary_timeout_rate_bps mismatch for step=${step.label}`
    );
  }
  if (expect.sample_summary_limited_rate_bps !== undefined) {
    assert.equal(
      Number(decision?.sample_summary?.rates_bps?.limited_rate_bps ?? -1),
      Number(expect.sample_summary_limited_rate_bps),
      `sample_summary_limited_rate_bps mismatch for step=${step.label}`
    );
  }
  if (expect.sample_summary_non_negative_delta_rate_bps !== undefined) {
    assert.equal(
      Number(decision?.sample_summary?.rates_bps?.non_negative_delta_rate_bps ?? -1),
      Number(expect.sample_summary_non_negative_delta_rate_bps),
      `sample_summary_non_negative_delta_rate_bps mismatch for step=${step.label}`
    );
  }
  if (expect.run_candidate_cycles_source === 'v1') {
    assert.equal(
      Number(run?.stats?.candidate_cycles ?? -1),
      Number(decision?.metrics?.v1_candidate_cycles ?? -2),
      `run candidate_cycles should match v1 metrics for step=${step.label}`
    );
  }
  if (expect.run_candidate_cycles_source === 'v2') {
    assert.equal(
      Number(run?.stats?.candidate_cycles ?? -1),
      Number(decision?.metrics?.v2_candidate_cycles ?? -2),
      `run candidate_cycles should match v2 metrics for step=${step.label}`
    );
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

const store = createSeededStore({ seedState: scenario.seed_state });
const service = new MarketplaceMatchingService({ store });

const stepSummaries = [];
for (const step of scenario.steps ?? []) {
  const requestPayload = canonicalize({
    ...(scenario.request_template ?? {}),
    ...(step?.request_overrides ?? {}),
    recorded_at: step?.recorded_at
  });
  validateRunRequest(requestPayload);

  const out = withIsolatedMatcherEnv(
    {
      ...(scenario.env ?? {}),
      ...(step?.env ?? {})
    },
    () =>
      service.runMatching({
        actor: clone(scenario.actor),
        auth: clone(scenario.auth),
        idempotencyKey: `m119_${String(step?.label ?? 'step')}`,
        request: requestPayload
      })
  );

  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, `runMatching should succeed for step=${step?.label}`);
  const run = out.result.body?.run;
  assert.ok(run, `run response missing for step=${step?.label}`);
  const decision = store.state.marketplace_matching_canary_decisions?.[run.run_id] ?? null;
  assert.ok(decision, `canary decision missing for step=${step?.label}`);
  assert.equal(
    Number(run?.stats?.candidate_cycles ?? -1),
    Number(decision?.metrics?.primary_candidate_cycles ?? -2),
    `run candidate_cycles should match primary metrics for step=${step?.label}`
  );

  assertStepExpectations({ step, run, decision });

  stepSummaries.push(
    canonicalize({
      label: String(step?.label ?? ''),
      run_id: String(run.run_id),
      primary_engine: String(decision?.primary_engine ?? ''),
      canary_selected: Boolean(decision?.canary_selected),
      skipped_reason: decision?.skipped_reason ?? null,
      routed_to_v2: Boolean(decision?.routed_to_v2),
      fallback_to_v1: Boolean(decision?.fallback_to_v1),
      rollback: {
        active_before: Boolean(decision?.rollback?.active_before),
        reason_code_before: decision?.rollback?.reason_code_before ?? null,
        active_after: Boolean(decision?.rollback?.active_after),
        reason_code_after: decision?.rollback?.reason_code_after ?? null,
        triggered: Boolean(decision?.rollback?.triggered),
        trigger_reason_code: decision?.rollback?.trigger_reason_code ?? null
      },
      v2_error: decision?.v2?.error
        ? {
          code: String(decision.v2.error.code),
          name: String(decision.v2.error.name),
          message: String(decision.v2.error.message)
        }
        : null,
      candidate_cycles: {
        run: Number(run?.stats?.candidate_cycles ?? 0),
        v1: Number(decision?.metrics?.v1_candidate_cycles ?? 0),
        v2: decision?.metrics?.v2_candidate_cycles === null ? null : Number(decision?.metrics?.v2_candidate_cycles),
        primary: Number(decision?.metrics?.primary_candidate_cycles ?? 0)
      },
      sample_summary: {
        samples_count: Number(decision?.sample_summary?.samples_count ?? 0),
        reason_code: decision?.sample_summary?.reason_code ?? null,
        rates_bps: {
          error_rate_bps: Number(decision?.sample_summary?.rates_bps?.error_rate_bps ?? 0),
          timeout_rate_bps: Number(decision?.sample_summary?.rates_bps?.timeout_rate_bps ?? 0),
          limited_rate_bps: Number(decision?.sample_summary?.rates_bps?.limited_rate_bps ?? 0),
          non_negative_delta_rate_bps: Number(decision?.sample_summary?.rates_bps?.non_negative_delta_rate_bps ?? 0)
        }
      }
    })
  );
}

const finalCanaryState = canonicalize({
  rollback_active: Boolean(store.state?.marketplace_matching_canary_state?.rollback_active),
  rollback_reason_code: store.state?.marketplace_matching_canary_state?.rollback_reason_code ?? null,
  rollback_run_id: store.state?.marketplace_matching_canary_state?.rollback_run_id ?? null,
  recent_samples_count: Number(store.state?.marketplace_matching_canary_state?.recent_samples?.length ?? 0)
});

const out = canonicalize({
  steps: stepSummaries,
  final_canary_state: finalCanaryState
});
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const actualHash = stableHash(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  steps_count: stepSummaries.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}
