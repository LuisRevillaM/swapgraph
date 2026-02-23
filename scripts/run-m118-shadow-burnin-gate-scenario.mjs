import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketplaceMatchingService } from '../src/service/marketplaceMatchingService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M118';
const SCENARIO_FILE = 'fixtures/release/m118_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m118_expected.json';
const OUTPUT_FILE = 'matching_v2_shadow_burnin_output.json';

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

function toBps(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((Number(numerator ?? 0) * 10000) / denominator);
}

function percentile95(values) {
  const nums = (values ?? []).map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0);
  if (nums.length === 0) return null;
  nums.sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(nums.length * 0.95) - 1);
  return nums[idx];
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides ?? {})) {
    previous.set(key, process.env[key]);
    process.env[key] = String(value);
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

function createSeededStore({ label, seedState }) {
  const store = new JsonStateStore({ filePath: path.join(outDir, `store_${label}.json`) });
  store.load();
  for (const [key, value] of Object.entries(seedState ?? {})) {
    store.state[key] = clone(value);
  }
  return store;
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(file => file.endsWith('.schema.json'));
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

function evaluateCase({ scenario, caseSpec }) {
  const label = String(caseSpec?.label ?? 'case');
  const runs = Array.isArray(caseSpec?.runs) ? caseSpec.runs : [];
  const totalRuns = runs.length;
  const thresholds = {
    min_shadow_records: Number(caseSpec?.thresholds?.min_shadow_records ?? totalRuns),
    max_shadow_error_rate_bps: Number(caseSpec?.thresholds?.max_shadow_error_rate_bps ?? 0),
    max_timeout_rate_bps: Number(caseSpec?.thresholds?.max_timeout_rate_bps ?? 0),
    max_limited_rate_bps: Number(caseSpec?.thresholds?.max_limited_rate_bps ?? 0),
    min_cycle_gain_rate_bps: Number(caseSpec?.thresholds?.min_cycle_gain_rate_bps ?? 0),
    min_non_negative_delta_rate_bps: Number(caseSpec?.thresholds?.min_non_negative_delta_rate_bps ?? 10000),
    max_v2_runtime_p95_ms: Number(caseSpec?.thresholds?.max_v2_runtime_p95_ms ?? 5000)
  };

  const store = createSeededStore({ label, seedState: scenario.seed_state });
  const service = new MarketplaceMatchingService({ store });

  const observed = [];
  for (let idx = 0; idx < runs.length; idx += 1) {
    const runConfig = runs[idx] ?? {};
    const request = canonicalize({
      ...(scenario.request_template ?? {}),
      ...(caseSpec.request_overrides ?? {}),
      ...(runConfig.request_overrides ?? {}),
      recorded_at: runConfig.recorded_at
    });

    validateRunRequest(request);
    const out = service.runMatching({
      actor: clone(scenario.actor),
      auth: clone(scenario.auth),
      idempotencyKey: `m118_${label}_${String(idx + 1).padStart(3, '0')}`,
      request
    });
    validateRunResponse(out.result);
    assert.equal(out.result.ok, true, `runMatching should succeed for case=${label} idx=${idx}`);

    const runId = out.result.body?.run?.run_id;
    assert.ok(runId, `run_id missing for case=${label} idx=${idx}`);

    observed.push({
      run_id: runId,
      shadow: clone(store.state.marketplace_matching_shadow_diffs?.[runId] ?? null)
    });
  }

  const uniqueRunIds = new Set(observed.map(row => row.run_id));
  assert.equal(uniqueRunIds.size, observed.length, `run_id collision in case=${label}`);

  const shadowRecords = observed.map(row => row.shadow).filter(row => row && typeof row === 'object');
  const errorRecords = shadowRecords.filter(row => row.shadow_error && typeof row.shadow_error === 'object');
  const metricRecords = shadowRecords.filter(row => row.metrics && typeof row.metrics === 'object');
  const timeoutCount = metricRecords.filter(row => row?.v2_safety_triggers?.timeout_reached === true).length;
  const limitedCount = metricRecords.filter(row => row?.v2_safety_triggers?.max_cycles_reached === true).length;
  const cycleGainCount = metricRecords.filter(row => Number(row?.metrics?.v2_candidate_cycles ?? 0) > Number(row?.metrics?.v1_candidate_cycles ?? 0)).length;
  const nonNegativeDeltaCount = metricRecords.filter(row => Number(row?.metrics?.delta_score_sum_scaled ?? 0) >= 0).length;
  const v2RuntimeSamples = metricRecords.map(row => Number(row?.metrics?.v2_runtime_ms)).filter(value => Number.isFinite(value) && value >= 0);
  const v2RuntimeP95 = percentile95(v2RuntimeSamples);

  const ratesBps = {
    shadow_error_rate_bps: toBps(errorRecords.length, totalRuns),
    timeout_rate_bps: toBps(timeoutCount, totalRuns),
    limited_rate_bps: toBps(limitedCount, totalRuns),
    cycle_gain_rate_bps: toBps(cycleGainCount, totalRuns),
    non_negative_delta_rate_bps: toBps(nonNegativeDeltaCount, totalRuns)
  };

  const checks = {
    min_shadow_records_ok: shadowRecords.length >= thresholds.min_shadow_records,
    shadow_error_rate_ok: ratesBps.shadow_error_rate_bps <= thresholds.max_shadow_error_rate_bps,
    timeout_rate_ok: ratesBps.timeout_rate_bps <= thresholds.max_timeout_rate_bps,
    limited_rate_ok: ratesBps.limited_rate_bps <= thresholds.max_limited_rate_bps,
    cycle_gain_rate_ok: ratesBps.cycle_gain_rate_bps >= thresholds.min_cycle_gain_rate_bps,
    non_negative_delta_rate_ok: ratesBps.non_negative_delta_rate_bps >= thresholds.min_non_negative_delta_rate_bps,
    v2_runtime_p95_ok: v2RuntimeP95 !== null && v2RuntimeP95 <= thresholds.max_v2_runtime_p95_ms
  };

  const failedChecks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .sort();

  const gatePass = failedChecks.length === 0;
  const expectPass = caseSpec?.expect_pass === true;
  assert.equal(gatePass, expectPass, `burn-in gate mismatch for case=${label}`);

  return canonicalize({
    label,
    expect_pass: expectPass,
    gate_pass: gatePass,
    total_runs: totalRuns,
    observed: {
      shadow_records: shadowRecords.length,
      shadow_error_records: errorRecords.length,
      metrics_records: metricRecords.length
    },
    rates_bps: ratesBps,
    checks,
    failed_checks: failedChecks
  });
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

const caseResults = [];
for (const caseSpec of scenario.cases ?? []) {
  const rec = withEnv(caseSpec.env ?? {}, () => evaluateCase({ scenario, caseSpec }));
  caseResults.push(rec);
}

const out = canonicalize({
  cases: caseResults
});
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const actualHash = stableHash(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  cases_count: caseResults.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
