import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketplaceMatchingService } from '../src/service/marketplaceMatchingService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M117';
const SCENARIO_FILE = 'fixtures/release/m117_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m117_expected.json';
const OUTPUT_FILE = 'matching_v2_shadow_output.json';

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

function runSequenceFromRunId(runId) {
  const match = /^mrun_(\d+)$/.exec(String(runId ?? ''));
  if (!match) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function sortRunIdsNumerically(runIds) {
  return [...runIds].sort((a, b) => {
    const seqA = runSequenceFromRunId(a);
    const seqB = runSequenceFromRunId(b);
    if (seqA !== seqB) return seqA - seqB;
    return String(a).localeCompare(String(b));
  });
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
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));
const runEndpoint = endpointsByOp.get('marketplaceMatching.run');
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

function normalizeShadowRecord(shadow) {
  return canonicalize({
    v1_cycle_bounds: shadow?.v1_cycle_bounds ?? null,
    v2_cycle_bounds: shadow?.v2_cycle_bounds ?? null,
    v2_safety_limits: shadow?.v2_safety_limits ?? null,
    metrics: {
      v1_candidate_cycles: Number(shadow?.metrics?.v1_candidate_cycles ?? 0),
      v2_candidate_cycles: Number(shadow?.metrics?.v2_candidate_cycles ?? 0),
      v1_selected_proposals: Number(shadow?.metrics?.v1_selected_proposals ?? 0),
      v2_selected_proposals: Number(shadow?.metrics?.v2_selected_proposals ?? 0),
      v1_vs_v2_overlap: Number(shadow?.metrics?.v1_vs_v2_overlap ?? 0),
      delta_score_sum_scaled: Number(shadow?.metrics?.delta_score_sum_scaled ?? 0),
      delta_score_sum: Number(shadow?.metrics?.delta_score_sum ?? 0)
    },
    v2_safety_triggers: {
      max_cycles_reached: Boolean(shadow?.v2_safety_triggers?.max_cycles_reached),
      timeout_reached: Boolean(shadow?.v2_safety_triggers?.timeout_reached)
    },
    selected_cycle_keys: {
      overlap_count: Number(shadow?.selected_cycle_keys?.overlap_count ?? 0),
      only_v1_count: Number(shadow?.selected_cycle_keys?.only_v1_count ?? 0),
      only_v2_count: Number(shadow?.selected_cycle_keys?.only_v2_count ?? 0),
      overlap: [...(shadow?.selected_cycle_keys?.overlap ?? [])].sort(),
      only_v1: [...(shadow?.selected_cycle_keys?.only_v1 ?? [])].sort(),
      only_v2: [...(shadow?.selected_cycle_keys?.only_v2 ?? [])].sort()
    }
  });
}

function normalizeShadowErrorRecord(shadow) {
  return canonicalize({
    run_id: String(shadow?.run_id ?? ''),
    recorded_at: String(shadow?.recorded_at ?? ''),
    shadow_error: {
      code: String(shadow?.shadow_error?.code ?? ''),
      name: String(shadow?.shadow_error?.name ?? ''),
      message: String(shadow?.shadow_error?.message ?? '')
    },
    v2_cycle_bounds: shadow?.v2_cycle_bounds ?? null,
    v2_safety_limits: shadow?.v2_safety_limits ?? null
  });
}

function createSeededStore({ label, seedState }) {
  const store = new JsonStateStore({ filePath: path.join(outDir, `store_${label}.json`) });
  store.load();
  for (const [key, value] of Object.entries(seedState ?? {})) {
    store.state[key] = clone(value);
  }
  return store;
}

function runCase({ label, scenario, seedState = null }) {
  const store = createSeededStore({ label, seedState: seedState ?? scenario.seed_state });
  const service = new MarketplaceMatchingService({ store });
  const request = clone(scenario.request ?? {});
  validateRunRequest(request);

  const out = service.runMatching({
    actor: clone(scenario.actor),
    auth: clone(scenario.auth),
    idempotencyKey: `m117_${label}`,
    request
  });
  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, 'matching run should succeed');

  const run = out.result.body?.run;
  assert.ok(run, 'run response must include run');

  const shadow = store.state.marketplace_matching_shadow_diffs?.[run.run_id] ?? null;
  assert.ok(shadow, 'shadow diff should exist when MATCHING_V2_SHADOW=1');
  assert.equal(shadow.run_id, run.run_id, 'shadow diff run_id should match run');
  assert.equal(shadow.recorded_at, run.recorded_at, 'shadow diff recorded_at should match run');

  const v1Runtime = shadow?.metrics?.v1_runtime_ms;
  const v2Runtime = shadow?.metrics?.v2_runtime_ms;
  assert.equal(typeof v1Runtime, 'number', 'v1 runtime metric should be numeric');
  assert.equal(typeof v2Runtime, 'number', 'v2 runtime metric should be numeric');
  assert.ok(Number.isFinite(v1Runtime) && v1Runtime >= 0, 'v1 runtime metric must be finite and non-negative');
  assert.ok(Number.isFinite(v2Runtime) && v2Runtime >= 0, 'v2 runtime metric must be finite and non-negative');

  const structuralShadow = normalizeShadowRecord(shadow);
  assert.equal(
    Number(run.stats?.candidate_cycles ?? 0),
    Number(structuralShadow.metrics.v1_candidate_cycles ?? 0),
    'run stats candidate_cycles should match v1 metrics'
  );
  assert.equal(
    Number(run.selected_proposals_count ?? 0),
    Number(structuralShadow.metrics.v1_selected_proposals ?? 0),
    'selected_proposals_count should match capped v1 selected proposals'
  );

  return {
    run_summary: {
      run_id: run.run_id,
      selected_proposals_count: Number(run.selected_proposals_count ?? 0),
      candidate_cycles: Number(run.stats?.candidate_cycles ?? 0)
    },
    structural_shadow: structuralShadow,
    runtime_metrics_present: true
  };
}

function runShadowErrorCase({ label, scenario }) {
  const store = createSeededStore({ label, seedState: scenario.seed_state });
  const service = new MarketplaceMatchingService({ store });
  const request = clone(scenario.request ?? {});
  validateRunRequest(request);

  const out = service.runMatching({
    actor: clone(scenario.actor),
    auth: clone(scenario.auth),
    idempotencyKey: `m117_${label}`,
    request
  });
  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, 'v1 result should still succeed when shadow fails');

  const run = out.result.body?.run;
  assert.ok(run, 'run response must include run');
  const shadow = store.state.marketplace_matching_shadow_diffs?.[run.run_id] ?? null;
  assert.ok(shadow, 'shadow fallback record should exist when shadow run fails');
  assert.ok(shadow?.shadow_error, 'shadow fallback record should include shadow_error');
  assert.equal(shadow.shadow_error.code, 'matching_v2_shadow_failed', 'shadow error code mismatch');
  assert.equal(typeof shadow.shadow_error.name, 'string', 'shadow error name must be string');
  assert.equal(typeof shadow.shadow_error.message, 'string', 'shadow error message must be string');

  return {
    run_summary: {
      run_id: run.run_id,
      selected_proposals_count: Number(run.selected_proposals_count ?? 0),
      candidate_cycles: Number(run.stats?.candidate_cycles ?? 0)
    },
    shadow_error: normalizeShadowErrorRecord(shadow)
  };
}

function runRetentionRolloverCase({ label, scenario }) {
  const retentionSeed = canonicalize({
    ...(scenario.seed_state ?? {}),
    ...(scenario.retention_seed_state ?? {})
  });
  const store = createSeededStore({ label, seedState: retentionSeed });
  const service = new MarketplaceMatchingService({ store });
  const request = clone(scenario.request ?? {});
  validateRunRequest(request);

  const beforeRunIds = sortRunIdsNumerically(Object.keys(store.state.marketplace_matching_shadow_diffs ?? {}));
  const out = service.runMatching({
    actor: clone(scenario.actor),
    auth: clone(scenario.auth),
    idempotencyKey: `m117_${label}`,
    request
  });
  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, 'rollover retention run should succeed');

  const run = out.result.body?.run;
  assert.ok(run, 'retention run response must include run');
  const afterRunIds = sortRunIdsNumerically(Object.keys(store.state.marketplace_matching_shadow_diffs ?? {}));

  const expect = scenario.retention_expect ?? {};
  const expectedKept = sortRunIdsNumerically(expect.kept_run_ids ?? []);
  const expectedPruned = sortRunIdsNumerically(expect.pruned_run_ids ?? []);
  const actualPruned = beforeRunIds.filter(id => !afterRunIds.includes(id));

  assert.equal(afterRunIds.length, Number(expect.max_shadow_diffs ?? afterRunIds.length), 'retention count mismatch');
  assert.deepEqual(afterRunIds, expectedKept, 'retention kept set mismatch');
  assert.deepEqual(sortRunIdsNumerically(actualPruned), expectedPruned, 'retention pruned set mismatch');
  assert.ok(afterRunIds.includes(run.run_id), 'latest run id must be retained');

  return {
    run_id: run.run_id,
    before_run_ids: beforeRunIds,
    after_run_ids: afterRunIds,
    pruned_run_ids: sortRunIdsNumerically(actualPruned)
  };
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

const { first, second } = withIsolatedMatcherEnv(scenario.shadow_env ?? {}, () => ({
  first: runCase({ label: 'a', scenario }),
  second: runCase({ label: 'b', scenario })
}));

assert.deepEqual(
  first.structural_shadow,
  second.structural_shadow,
  'shadow structural metrics must be deterministic for the same snapshot'
);

const shadowMetrics = first.structural_shadow.metrics;
assert.ok(
  Number(shadowMetrics.v2_candidate_cycles ?? 0) > Number(shadowMetrics.v1_candidate_cycles ?? 0),
  'expected shadow v2 to discover additional bounded cycles in this fixture'
);

const errorCase = withIsolatedMatcherEnv(scenario.shadow_error_env ?? {}, () => runShadowErrorCase({ label: 'error', scenario }));
const retentionCase = withIsolatedMatcherEnv(scenario.retention_env ?? {}, () => runRetentionRolloverCase({ label: 'rollover', scenario }));

const out = canonicalize({
  deterministic_shadow_metrics: true,
  shadow_structural_hash: stableHash(first.structural_shadow),
  run_summary: first.run_summary,
  shadow: first.structural_shadow,
  shadow_error_fallback: errorCase,
  retention_rollover: retentionCase
});
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const actualHash = stableHash(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
