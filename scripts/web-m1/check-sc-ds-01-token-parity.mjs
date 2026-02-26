#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const designSpecPath = path.join(repoRoot, 'docs/design/MarketplaceClientDesignSpec.md');
const tokenSourcePath = path.join(repoRoot, 'client/marketplace/tokens/design-tokens.json');
const generatedCssPath = path.join(repoRoot, 'client/marketplace/generated/tokens.css');
const outPath = path.join(repoRoot, 'artifacts/web-m1/sc-ds-01-token-parity-report.json');

function extractDesignExport(markdown) {
  const sectionStart = markdown.indexOf('## 8. Design Token Export (for implementation)');
  if (sectionStart === -1) throw new Error('design token export section missing');

  const section = markdown.slice(sectionStart);
  const match = /```json\s*([\s\S]*?)```/.exec(section);
  if (!match) throw new Error('json token export block missing');
  return JSON.parse(match[1]);
}

function compareValues(expected, actual, pathStack = []) {
  const pathLabel = pathStack.join('.') || '(root)';
  const mismatches = [];

  if (typeof expected !== typeof actual) {
    mismatches.push({ path: pathLabel, expected, actual, reason: 'type_mismatch' });
    return mismatches;
  }

  if (expected === null || actual === null) {
    if (expected !== actual) mismatches.push({ path: pathLabel, expected, actual, reason: 'null_mismatch' });
    return mismatches;
  }

  if (typeof expected !== 'object') {
    if (Number.isFinite(expected) && Number.isFinite(actual)) {
      if (Math.abs(expected - actual) > 1e-9) {
        mismatches.push({ path: pathLabel, expected, actual, reason: 'number_mismatch' });
      }
      return mismatches;
    }

    if (expected !== actual) {
      mismatches.push({ path: pathLabel, expected, actual, reason: 'value_mismatch' });
    }
    return mismatches;
  }

  if (Array.isArray(expected) !== Array.isArray(actual)) {
    mismatches.push({ path: pathLabel, expected, actual, reason: 'array_shape_mismatch' });
    return mismatches;
  }

  const expectedKeys = Array.isArray(expected) ? expected.map((_, idx) => idx) : Object.keys(expected);
  const actualKeys = Array.isArray(actual) ? actual.map((_, idx) => idx) : Object.keys(actual);

  for (const key of expectedKeys) {
    if (!(key in actual)) {
      mismatches.push({ path: `${pathLabel}.${String(key)}`, expected: expected[key], actual: undefined, reason: 'missing_actual' });
      continue;
    }
    mismatches.push(...compareValues(expected[key], actual[key], [...pathStack, String(key)]));
  }

  for (const key of actualKeys) {
    if (!(key in expected)) {
      mismatches.push({ path: `${pathLabel}.${String(key)}`, expected: undefined, actual: actual[key], reason: 'unexpected_actual' });
    }
  }

  return mismatches;
}

function parseCssVars(cssText) {
  const out = new Map();
  const pattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of cssText.matchAll(pattern)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

function expectedCssVars(tokens) {
  const expected = new Map();

  for (const [key, value] of Object.entries(tokens.color ?? {})) expected.set(key, String(value));
  for (const [key, value] of Object.entries(tokens.typography?.families ?? {})) expected.set(`font-${key}`, `"${String(value)}"`);
  for (const [key, value] of Object.entries(tokens.typography?.scale ?? {})) {
    if (typeof value?.rem === 'number') expected.set(`t-${key}`, `${value.rem}rem`);
    if (typeof value?.px === 'number') expected.set(`t-${key}-px`, `${value.px}px`);
  }

  expected.set('readability-floor-rem', 'var(--t-sm)');
  expected.set('readability-floor-px', '11.3');

  for (const [key, value] of Object.entries(tokens.spacing ?? {})) expected.set(key, String(value));
  for (const [key, value] of Object.entries(tokens.shadow ?? {})) expected.set(`shadow-${key}`, String(value));

  return expected;
}

function main() {
  const designSpec = readFileSync(designSpecPath, 'utf8');
  const sourceTokens = JSON.parse(readFileSync(tokenSourcePath, 'utf8'));
  const generatedCss = readFileSync(generatedCssPath, 'utf8');

  const exportedTokens = extractDesignExport(designSpec);
  const tokenMismatches = compareValues(exportedTokens, sourceTokens);

  const cssActual = parseCssVars(generatedCss);
  const cssExpected = expectedCssVars(sourceTokens);
  const cssMismatches = [];

  for (const [name, expectedValue] of cssExpected.entries()) {
    const actualValue = cssActual.get(name);
    if (actualValue !== expectedValue) {
      cssMismatches.push({ variable: `--${name}`, expected: expectedValue, actual: actualValue ?? null });
    }
  }

  const output = {
    check_id: 'SC-DS-01',
    generated_at: new Date().toISOString(),
    sources: {
      design_spec: path.relative(repoRoot, designSpecPath),
      token_source: path.relative(repoRoot, tokenSourcePath),
      generated_css: path.relative(repoRoot, generatedCssPath)
    },
    token_mismatch_count: tokenMismatches.length,
    token_mismatches: tokenMismatches,
    css_mismatch_count: cssMismatches.length,
    css_mismatches: cssMismatches,
    pass: tokenMismatches.length === 0 && cssMismatches.length === 0
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
