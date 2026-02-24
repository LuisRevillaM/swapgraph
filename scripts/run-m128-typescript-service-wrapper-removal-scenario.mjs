import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M128';
const SCENARIO_FILE = 'fixtures/release/m128_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m128_expected.json';
const OUTPUT_FILE = 'typescript_service_wrapper_removal_output.json';

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

function parseExportTargets(source) {
  return [...source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)].map(match => String(match[1]));
}

function parseExportClasses(source) {
  return [...source.matchAll(/export\s+class\s+([A-Za-z0-9_]+)\s*/g)].map(match => String(match[1])).sort();
}

function parseImportTargets(source) {
  return [...source.matchAll(/import\s+.+?\s+from\s+['"]([^'"]+)['"]/g)].map(match => String(match[1])).sort();
}

function parseWrapperRow({ scenario, shadowModule }) {
  const wrappers = Array.isArray(scenario?.wrapper_modules) ? scenario.wrapper_modules : [];
  return wrappers.find(row => String(row?.shadow_module ?? '') === shadowModule) ?? null;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const m121Scenario = readJson(path.join(root, 'fixtures/release/m121_scenario.json'));

assert.equal(String(scenario?.milestone ?? ''), MILESTONE, 'scenario milestone mismatch');

const moduleContract = scenario?.module_contract ?? {};
const shadowModuleRel = String(moduleContract?.shadow_module ?? '');
const sourceModuleRel = String(moduleContract?.source_module ?? '');
const expectedImportTarget = String(moduleContract?.expected_import_target ?? '');
const expectedExportClasses = [...(moduleContract?.expected_export_classes ?? [])].map(String).sort();
const requiredM121Flags = canonicalize(moduleContract?.m121_contract ?? {});

assert.ok(shadowModuleRel.length > 0, 'shadow_module required');
assert.ok(sourceModuleRel.length > 0, 'source_module required');
assert.ok(expectedImportTarget.length > 0, 'expected_import_target required');
assert.ok(expectedExportClasses.length > 0, 'expected_export_classes required');

const shadowFile = path.join(root, shadowModuleRel);
const sourceFile = path.join(root, sourceModuleRel);
assert.ok(existsSync(shadowFile), `missing shadow module: ${shadowModuleRel}`);
assert.ok(existsSync(sourceFile), `missing source module: ${sourceModuleRel}`);

const shadowSource = readFileSync(shadowFile, 'utf8');
const sourceSource = readFileSync(sourceFile, 'utf8');

const shadowExportTargets = parseExportTargets(shadowSource);
assert.equal(shadowExportTargets.length, 0, 'shadow module must not use export* wrapper');

const shadowImportTargets = parseImportTargets(shadowSource);
assert.ok(
  shadowImportTargets.includes(expectedImportTarget),
  `shadow module missing required import target: ${expectedImportTarget}`
);

const shadowExportClasses = parseExportClasses(shadowSource);
const sourceExportClasses = parseExportClasses(sourceSource);
assert.deepEqual(shadowExportClasses, expectedExportClasses, 'shadow export class contract mismatch');
assert.deepEqual(sourceExportClasses, expectedExportClasses, 'source export class contract mismatch');

const m121WrapperRow = parseWrapperRow({
  scenario: m121Scenario,
  shadowModule: shadowModuleRel
});
assert.ok(m121WrapperRow, `m121 wrapper row missing for ${shadowModuleRel}`);
assert.equal(Boolean(m121WrapperRow.allow_concrete), Boolean(requiredM121Flags.allow_concrete), 'm121 allow_concrete mismatch');
assert.deepEqual(
  [...(m121WrapperRow.expected_export_symbols ?? [])].map(String).sort(),
  [...(requiredM121Flags.expected_export_symbols ?? [])].map(String).sort(),
  'm121 expected_export_symbols mismatch'
);

const out = canonicalize({
  milestone: MILESTONE,
  parity_dependency_verifiers: Array.isArray(scenario?.parity_dependency_verifiers)
    ? scenario.parity_dependency_verifiers.map(String)
    : [],
  module: {
    shadow_module: shadowModuleRel,
    source_module: sourceModuleRel,
    import_targets: shadowImportTargets,
    export_classes: shadowExportClasses
  },
  m121_contract: {
    shadow_module: shadowModuleRel,
    allow_concrete: Boolean(m121WrapperRow.allow_concrete),
    expected_export_symbols: [...(m121WrapperRow.expected_export_symbols ?? [])].map(String).sort()
  }
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const actualHash = stableHash(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  export_class_count: shadowExportClasses.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
