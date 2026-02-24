import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketplaceMatchingService } from '../src/service/marketplaceMatchingService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M125';
const SCENARIO_FILE = 'fixtures/release/m125_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m125_expected.json';
const OUTPUT_FILE = 'typescript_runtime_shadow_output.json';

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
    ...Object.keys(process.env).filter(key => key.startsWith('MATCHING_V2_') || key.startsWith('MATCHING_TS_')),
    ...Object.keys(caseEnv).filter(key => key.startsWith('MATCHING_V2_') || key.startsWith('MATCHING_TS_'))
  ]);
  const otherKeys = Object.keys(caseEnv).filter(key => !key.startsWith('MATCHING_V2_') && !key.startsWith('MATCHING_TS_'));
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

function normalizeTsShadowRecord(record) {
  const overlap = [...(record?.selected_cycle_keys?.overlap ?? [])].map(String).sort();
  const onlyJs = [...(record?.selected_cycle_keys?.only_js ?? [])].map(String).sort();
  const onlyTs = [...(record?.selected_cycle_keys?.only_ts ?? [])].map(String).sort();
  return canonicalize({
    primary_engine: String(record?.primary_engine ?? ''),
    matcher_cycle_bounds: record?.matcher_cycle_bounds ?? null,
    matcher_safety_limits: record?.matcher_safety_limits ?? null,
    metrics: {
      js_candidate_cycles: Number(record?.metrics?.js_candidate_cycles ?? 0),
      ts_candidate_cycles: Number(record?.metrics?.ts_candidate_cycles ?? 0),
      js_selected_proposals: Number(record?.metrics?.js_selected_proposals ?? 0),
      ts_selected_proposals: Number(record?.metrics?.ts_selected_proposals ?? 0),
      js_vs_ts_overlap: Number(record?.metrics?.js_vs_ts_overlap ?? 0),
      delta_score_sum_scaled: Number(record?.metrics?.delta_score_sum_scaled ?? 0),
      delta_score_sum: Number(record?.metrics?.delta_score_sum ?? 0)
    },
    js_safety_triggers: {
      max_cycles_reached: Boolean(record?.js_safety_triggers?.max_cycles_reached),
      timeout_reached: Boolean(record?.js_safety_triggers?.timeout_reached)
    },
    ts_safety_triggers: {
      max_cycles_reached: Boolean(record?.ts_safety_triggers?.max_cycles_reached),
      timeout_reached: Boolean(record?.ts_safety_triggers?.timeout_reached)
    },
    selected_cycle_keys: {
      overlap_count: overlap.length,
      only_js_count: onlyJs.length,
      only_ts_count: onlyTs.length,
      overlap,
      only_js: onlyJs,
      only_ts: onlyTs
    }
  });
}

function normalizeTsShadowErrorRecord(record) {
  return canonicalize({
    run_id: String(record?.run_id ?? ''),
    recorded_at: String(record?.recorded_at ?? ''),
    primary_engine: String(record?.primary_engine ?? ''),
    ts_shadow_error: {
      code: String(record?.ts_shadow_error?.code ?? ''),
      name: String(record?.ts_shadow_error?.name ?? ''),
      message: String(record?.ts_shadow_error?.message ?? '')
    },
    matcher_cycle_bounds: record?.matcher_cycle_bounds ?? null,
    matcher_safety_limits: record?.matcher_safety_limits ?? null
  });
}

function createSeededStore({ label, seedState }) {
  const store = new JsonStateStore({ filePath: path.join(outDir, `store_m125_${label}.json`) });
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
    idempotencyKey: `m125_${label}`,
    request
  });
  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, 'matching run should succeed');

  const run = out.result.body?.run;
  assert.ok(run, 'run response must include run');

  const shadowRecord = store.state.marketplace_matching_ts_shadow_diffs?.[run.run_id] ?? null;
  assert.ok(shadowRecord, 'ts shadow diff should exist when MATCHING_TS_SHADOW=1');
  assert.equal(shadowRecord.run_id, run.run_id, 'ts shadow run_id should match run');
  assert.equal(shadowRecord.recorded_at, run.recorded_at, 'ts shadow recorded_at should match run');
  assert.equal(Boolean(shadowRecord?.ts_shadow_error), false, 'ts shadow success case should not include ts_shadow_error');

  const jsRuntime = shadowRecord?.metrics?.js_runtime_ms;
  const tsRuntime = shadowRecord?.metrics?.ts_runtime_ms;
  assert.equal(typeof jsRuntime, 'number', 'js runtime metric should be numeric');
  assert.equal(typeof tsRuntime, 'number', 'ts runtime metric should be numeric');
  assert.ok(Number.isFinite(jsRuntime) && jsRuntime >= 0, 'js runtime metric must be finite and non-negative');
  assert.ok(Number.isFinite(tsRuntime) && tsRuntime >= 0, 'ts runtime metric must be finite and non-negative');

  const structural = normalizeTsShadowRecord(shadowRecord);
  assert.equal(
    Number(run.stats?.candidate_cycles ?? 0),
    Number(structural.metrics.js_candidate_cycles ?? -1),
    'run stats candidate_cycles should match js metrics'
  );
  assert.equal(
    Number(run.selected_proposals_count ?? 0),
    Number(structural.metrics.js_selected_proposals ?? -1),
    'selected_proposals_count should match capped js selected proposals'
  );
  assert.equal(Number(structural.metrics.delta_score_sum_scaled ?? 1), 0, 'js/ts delta_score_sum_scaled should be zero');
  assert.equal(Number(structural.selected_cycle_keys.only_js_count ?? 1), 0, 'ts shadow should not miss js selected cycles');
  assert.equal(Number(structural.selected_cycle_keys.only_ts_count ?? 1), 0, 'ts shadow should not introduce extra selected cycles');

  return {
    run_summary: {
      run_id: run.run_id,
      selected_proposals_count: Number(run.selected_proposals_count ?? 0),
      candidate_cycles: Number(run.stats?.candidate_cycles ?? 0)
    },
    structural_shadow: structural,
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
    idempotencyKey: `m125_${label}`,
    request
  });
  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, 'js primary result should still succeed when ts shadow fails');

  const run = out.result.body?.run;
  assert.ok(run, 'run response must include run');
  const shadowRecord = store.state.marketplace_matching_ts_shadow_diffs?.[run.run_id] ?? null;
  assert.ok(shadowRecord, 'ts shadow record should exist when ts shadow run fails');
  assert.ok(shadowRecord?.ts_shadow_error, 'ts shadow error record should include ts_shadow_error');
  assert.equal(shadowRecord.ts_shadow_error.code, 'matching_ts_shadow_failed', 'ts shadow error code mismatch');
  assert.equal(typeof shadowRecord.ts_shadow_error.name, 'string', 'ts shadow error name must be string');
  assert.equal(typeof shadowRecord.ts_shadow_error.message, 'string', 'ts shadow error message must be string');

  return {
    run_summary: {
      run_id: run.run_id,
      selected_proposals_count: Number(run.selected_proposals_count ?? 0),
      candidate_cycles: Number(run.stats?.candidate_cycles ?? 0)
    },
    shadow_error: normalizeTsShadowErrorRecord(shadowRecord)
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

  const beforeRunIds = sortRunIdsNumerically(Object.keys(store.state.marketplace_matching_ts_shadow_diffs ?? {}));
  const out = service.runMatching({
    actor: clone(scenario.actor),
    auth: clone(scenario.auth),
    idempotencyKey: `m125_${label}`,
    request
  });
  validateRunResponse(out.result);
  assert.equal(out.result.ok, true, 'retention rollover run should succeed');

  const run = out.result.body?.run;
  assert.ok(run, 'retention run response must include run');
  const afterRunIds = sortRunIdsNumerically(Object.keys(store.state.marketplace_matching_ts_shadow_diffs ?? {}));

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
assert.equal(String(scenario?.milestone ?? ''), MILESTONE, 'scenario milestone mismatch');

const { first, second } = withIsolatedMatcherEnv(scenario.ts_shadow_env ?? {}, () => ({
  first: runCase({ label: 'a', scenario }),
  second: runCase({ label: 'b', scenario })
}));

assert.deepEqual(
  first.structural_shadow,
  second.structural_shadow,
  'ts shadow structural metrics must be deterministic for the same snapshot'
);

const errorCase = withIsolatedMatcherEnv(scenario.ts_shadow_error_env ?? {}, () => runShadowErrorCase({ label: 'error', scenario }));
const retentionCase = withIsolatedMatcherEnv(scenario.retention_env ?? {}, () => runRetentionRolloverCase({ label: 'rollover', scenario }));

const out = canonicalize({
  deterministic_ts_shadow_metrics: true,
  ts_shadow_structural_hash: stableHash(first.structural_shadow),
  run_summary: first.run_summary,
  ts_shadow_record: first.structural_shadow,
  shadow_error_case: errorCase,
  retention_case: retentionCase
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const actualHash = stableHash(out);
const assertions = canonicalize({
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  run_id: first.run_summary.run_id,
  retention_kept_count: retentionCase.after_run_ids.length
});
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
