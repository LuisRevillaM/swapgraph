import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M121';
const SCENARIO_FILE = 'fixtures/release/m121_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m121_expected.json';
const OUTPUT_FILE = 'typescript_shadow_output.json';

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

function stableHash(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function toPosixRelative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function parseExportTargets(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const targets = [...source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)].map(match => String(match[1]));
  return targets;
}

function parseExportFunctions(source) {
  return [...source.matchAll(/export\s+function\s+([A-Za-z0-9_]+)\s*\(/g)].map(match => String(match[1])).sort();
}

function assertNoDuplicateWrappers(wrapperModules) {
  const seen = new Set();
  for (const wrapper of wrapperModules) {
    const key = String(wrapper?.shadow_module ?? '');
    assert.ok(key.length > 0, 'shadow_module must be set');
    assert.ok(!seen.has(key), `duplicate shadow_module in scenario: ${key}`);
    seen.add(key);
  }
}

async function buildWrapperSummary(wrapper) {
  const shadowRel = String(wrapper?.shadow_module ?? '');
  const sourceRel = String(wrapper?.source_module ?? '');
  const expectedExportFrom = String(wrapper?.expected_export_from ?? '');
  const allowConcrete = wrapper?.allow_concrete === true;
  const shadowFile = path.join(root, shadowRel);
  const sourceFile = path.join(root, sourceRel);

  assert.ok(existsSync(shadowFile), `missing shadow module: ${shadowRel}`);
  assert.ok(existsSync(sourceFile), `missing source module: ${sourceRel}`);

  const exportTargets = parseExportTargets(shadowFile);
  const shadowSource = readFileSync(shadowFile, 'utf8');
  const sourceSource = readFileSync(sourceFile, 'utf8');
  const sourceExportFunctions = parseExportFunctions(sourceSource);

  let exportMode = 'wrapper';
  let exportKeys = [];
  let exportFrom = null;
  let resolvedExportTargetRel = null;

  if (exportTargets.length === 1) {
    exportFrom = exportTargets[0];
    assert.equal(exportTargets[0], expectedExportFrom, `export target mismatch: ${shadowRel}`);

    const resolvedExportTarget = path.resolve(path.dirname(shadowFile), exportTargets[0]);
    resolvedExportTargetRel = toPosixRelative(resolvedExportTarget);
    assert.equal(
      resolvedExportTargetRel,
      toPosixRelative(sourceFile),
      `resolved export target mismatch: ${shadowRel}`
    );

    const sourceModule = await import(`${pathToFileURL(sourceFile).href}?m121=${encodeURIComponent(shadowRel)}`);
    exportKeys = Object.keys(sourceModule).sort();
    assert.ok(exportKeys.length > 0, `source module has no exports: ${sourceRel}`);
  } else if (exportTargets.length === 0 && allowConcrete) {
    exportMode = 'concrete';
    const shadowExportFunctions = parseExportFunctions(shadowSource);
    assert.ok(shadowExportFunctions.length > 0, `concrete module has no export functions: ${shadowRel}`);
    assert.deepEqual(
      shadowExportFunctions,
      sourceExportFunctions,
      `concrete export function parity mismatch: ${shadowRel}`
    );
    exportKeys = shadowExportFunctions;
  } else {
    assert.equal(exportTargets.length, 1, `shadow module must have one export target: ${shadowRel}`);
  }

  return canonicalize({
    shadow_module: shadowRel,
    source_module: sourceRel,
    export_mode: exportMode,
    export_from: exportFrom,
    resolved_export_target: resolvedExportTargetRel,
    allow_concrete: allowConcrete,
    export_keys: exportKeys,
    export_count: exportKeys.length
  });
}

function buildIndexSummary(contract) {
  const indexRel = String(contract?.index_module ?? '');
  const expectedExports = [...(contract?.expected_exports ?? [])].map(String);
  const indexFile = path.join(root, indexRel);
  assert.ok(existsSync(indexFile), `missing index module: ${indexRel}`);

  const exportTargets = parseExportTargets(indexFile);
  assert.deepEqual(exportTargets, expectedExports, `index export targets mismatch: ${indexRel}`);

  return canonicalize({
    index_module: indexRel,
    export_targets: exportTargets,
    export_count: exportTargets.length
  });
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const wrapperModules = Array.isArray(scenario.wrapper_modules) ? scenario.wrapper_modules : [];
const indexContracts = Array.isArray(scenario.index_contracts) ? scenario.index_contracts : [];
const parityDependencyVerifiers = Array.isArray(scenario.parity_dependency_verifiers)
  ? scenario.parity_dependency_verifiers.map(String)
  : [];

assert.equal(String(scenario?.milestone ?? ''), MILESTONE, 'scenario milestone mismatch');
assertNoDuplicateWrappers(wrapperModules);

const wrapperSummaries = [];
for (const wrapper of wrapperModules) {
  wrapperSummaries.push(await buildWrapperSummary(wrapper));
}

const indexSummaries = [];
for (const contract of indexContracts) {
  indexSummaries.push(buildIndexSummary(contract));
}

const output = canonicalize({
  milestone: MILESTONE,
  parity_dependency_verifiers: parityDependencyVerifiers,
  wrappers: wrapperSummaries,
  indexes: indexSummaries,
  summary: {
    wrappers_count: wrapperSummaries.length,
    indexes_count: indexSummaries.length,
    total_exports: wrapperSummaries.reduce((sum, item) => sum + Number(item.export_count ?? 0), 0)
  }
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(output, null, 2));

const actualHash = stableHash(output);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  wrappers_count: wrapperSummaries.length,
  indexes_count: indexSummaries.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}
