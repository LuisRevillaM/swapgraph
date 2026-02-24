import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M130';
const SCENARIO_FILE = 'fixtures/release/m130_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m130_expected.json';
const OUTPUT_FILE = 'typescript_service_canary_helper_parity_output.json';

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

function parseExportTargets(filePath) {
  const source = readFileSync(filePath, 'utf8');
  return [...source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)].map(match => String(match[1]));
}

function parseExportFunctions(source) {
  return [...source.matchAll(/export\s+function\s+([A-Za-z0-9_]+)\s*\(/g)].map(match => String(match[1]));
}

function parseImportTargets(source) {
  return [...source.matchAll(/import\s+.+?\s+from\s+['"]([^'"]+)['"]/g)].map(match => String(match[1]));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeModuleForParity(source) {
  const withoutImports = source
    .split('\n')
    .filter(line => !line.trim().startsWith('import '))
    .join('\n');

  return withoutImports
    .replace(/\bexport\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertUniqueShadowModules(modules) {
  const seen = new Set();
  for (const row of modules) {
    const key = String(row?.shadow_module ?? '');
    assert.ok(key.length > 0, 'shadow_module must be set');
    assert.ok(!seen.has(key), `duplicate shadow_module: ${key}`);
    seen.add(key);
  }
}

function buildModuleSummary(record) {
  const shadowRel = String(record?.shadow_module ?? '');
  const sourceRel = String(record?.source_module ?? '');
  const expectedExportFunctions = [...(record?.expected_export_functions ?? [])].map(String).sort();
  const expectedImports = [...(record?.expected_imports ?? [])].map(String).sort();
  const shadowFile = path.join(root, shadowRel);
  const sourceFile = path.join(root, sourceRel);

  assert.ok(shadowRel.length > 0, 'shadow_module is required');
  assert.ok(sourceRel.length > 0, 'source_module is required');
  assert.ok(existsSync(shadowFile), `missing shadow module: ${shadowRel}`);
  assert.ok(existsSync(sourceFile), `missing source module: ${sourceRel}`);

  const shadowSource = readFileSync(shadowFile, 'utf8');
  const sourceSource = readFileSync(sourceFile, 'utf8');

  const wrapperExportTargets = parseExportTargets(shadowFile);
  assert.equal(wrapperExportTargets.length, 0, `shadow module must not be a wrapper: ${shadowRel}`);

  const shadowExportFunctions = parseExportFunctions(shadowSource).sort();
  assert.deepEqual(shadowExportFunctions, expectedExportFunctions, `shadow export functions mismatch: ${shadowRel}`);

  const sourceExportFunctions = parseExportFunctions(sourceSource).sort();
  assert.deepEqual(sourceExportFunctions, expectedExportFunctions, `source export functions mismatch: ${sourceRel}`);

  const shadowImportTargets = parseImportTargets(shadowSource).sort();
  const missingImports = expectedImports.filter(target => !shadowImportTargets.includes(target));
  assert.equal(missingImports.length, 0, `shadow imports missing expected targets: ${shadowRel}`);

  const normalizedSource = normalizeModuleForParity(sourceSource);
  const normalizedShadow = normalizeModuleForParity(shadowSource);
  const sourceParityHash = createHash('sha256').update(normalizedSource, 'utf8').digest('hex');
  const shadowParityHash = createHash('sha256').update(normalizedShadow, 'utf8').digest('hex');
  assert.equal(
    shadowParityHash,
    sourceParityHash,
    `normalized module parity hash mismatch: ${shadowRel} vs ${sourceRel}`
  );

  return canonicalize({
    shadow_module: shadowRel,
    source_module: sourceRel,
    export_functions: shadowExportFunctions,
    import_targets: shadowImportTargets,
    normalized_parity_hash: shadowParityHash
  });
}

function buildExtractionSummary(contract) {
  const serviceModuleRel = String(contract?.service_module ?? '');
  const helperModuleRel = String(contract?.helper_module ?? '');
  const helperModuleImport = String(contract?.helper_module_import ?? '');
  const expectedExternalizedFunctions = [...(contract?.expected_externalized_functions ?? [])].map(String).sort();

  const serviceFile = path.join(root, serviceModuleRel);
  const helperFile = path.join(root, helperModuleRel);
  assert.ok(serviceModuleRel.length > 0, 'service_module is required');
  assert.ok(helperModuleRel.length > 0, 'helper_module is required');
  assert.ok(helperModuleImport.length > 0, 'helper_module_import is required');
  assert.ok(existsSync(serviceFile), `missing service module: ${serviceModuleRel}`);
  assert.ok(existsSync(helperFile), `missing helper module: ${helperModuleRel}`);

  const serviceSource = readFileSync(serviceFile, 'utf8');
  const helperSource = readFileSync(helperFile, 'utf8');

  const importRegex = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(helperModuleImport)}['"]`,
    'm'
  );
  const importMatch = serviceSource.match(importRegex);
  assert.ok(importMatch, `service helper import not found: ${serviceModuleRel}`);

  const importedNames = importMatch[1]
    .split(',')
    .map(value => String(value).trim())
    .filter(Boolean)
    .sort();
  for (const fnName of expectedExternalizedFunctions) {
    assert.ok(importedNames.includes(fnName), `service missing imported helper function: ${fnName}`);
    const localDefinitionRegex = new RegExp(`\\bfunction\\s+${escapeRegExp(fnName)}\\s*\\(`);
    assert.equal(localDefinitionRegex.test(serviceSource), false, `service still defines extracted helper locally: ${fnName}`);
    const helperExportRegex = new RegExp(`\\bexport\\s+function\\s+${escapeRegExp(fnName)}\\s*\\(`);
    assert.equal(helperExportRegex.test(helperSource), true, `helper module missing exported function: ${fnName}`);
  }

  return canonicalize({
    service_module: serviceModuleRel,
    helper_module: helperModuleRel,
    helper_module_import: helperModuleImport,
    expected_externalized_functions: expectedExternalizedFunctions,
    imported_functions: importedNames
  });
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

assert.equal(String(scenario?.milestone ?? ''), MILESTONE, 'scenario milestone mismatch');

const modules = Array.isArray(scenario?.migrated_modules) ? scenario.migrated_modules : [];
const extractionContracts = Array.isArray(scenario?.extraction_contracts) ? scenario.extraction_contracts : [];
const parityDependencyVerifiers = Array.isArray(scenario?.parity_dependency_verifiers)
  ? scenario.parity_dependency_verifiers.map(String)
  : [];

assertUniqueShadowModules(modules);

const moduleSummaries = modules.map(buildModuleSummary);
const extractionSummaries = extractionContracts.map(buildExtractionSummary);

const output = canonicalize({
  milestone: MILESTONE,
  parity_dependency_verifiers: parityDependencyVerifiers,
  migrated_modules: moduleSummaries,
  extraction_contracts: extractionSummaries,
  summary: {
    migrated_modules_count: moduleSummaries.length,
    extraction_contracts_count: extractionSummaries.length
  }
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(output, null, 2));

const actualHash = stableHash(output);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: actualHash,
  matched: actualHash === expected.expected_sha256,
  migrated_modules_count: moduleSummaries.length,
  extraction_contracts_count: extractionSummaries.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
