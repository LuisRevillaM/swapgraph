#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const specPath = path.join(repoRoot, 'docs/design/MarketplaceClientDesignSpec.md');
const iosTokenPath = path.join(repoRoot, 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Resources/marketplace_design_tokens.json');

const markdown = readFileSync(specPath, 'utf8');
const tokenBlockMatch = markdown.match(/## 8\. Design Token Export \(for implementation\)[\s\S]*?```json\n([\s\S]*?)\n```/);
if (!tokenBlockMatch) {
  console.error(JSON.stringify({ check_id: 'SC-DS-01', overall: false, error: 'Unable to locate design token JSON block' }, null, 2));
  process.exit(2);
}

const sourceTokens = JSON.parse(tokenBlockMatch[1]);
const iosTokens = JSON.parse(readFileSync(iosTokenPath, 'utf8'));

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, next]) => [key, stable(next)])
    );
  }
  return value;
}

function diffObjects(a, b, prefix = '$', out = []) {
  if (typeof a !== typeof b) {
    out.push({ path: prefix, expected_type: typeof a, actual_type: typeof b });
    return out;
  }

  if (a === null || b === null) {
    if (a !== b) {
      out.push({ path: prefix, expected: a, actual: b });
    }
    return out;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    const aLength = Array.isArray(a) ? a.length : -1;
    const bLength = Array.isArray(b) ? b.length : -1;
    if (aLength !== bLength) {
      out.push({ path: prefix, expected_length: aLength, actual_length: bLength });
      return out;
    }

    for (let index = 0; index < aLength; index += 1) {
      diffObjects(a[index], b[index], `${prefix}[${index}]`, out);
      if (out.length > 20) return out;
    }
    return out;
  }

  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of Array.from(keys).sort()) {
      if (!(key in a)) {
        out.push({ path: `${prefix}.${key}`, expected: '__missing__', actual: b[key] });
        continue;
      }
      if (!(key in b)) {
        out.push({ path: `${prefix}.${key}`, expected: a[key], actual: '__missing__' });
        continue;
      }
      diffObjects(a[key], b[key], `${prefix}.${key}`, out);
      if (out.length > 20) return out;
    }
    return out;
  }

  if (a !== b) {
    out.push({ path: prefix, expected: a, actual: b });
  }
  return out;
}

const sourceStable = stable(sourceTokens);
const iosStable = stable(iosTokens);
const identical = JSON.stringify(sourceStable) === JSON.stringify(iosStable);
const differences = identical ? [] : diffObjects(sourceStable, iosStable);

const report = {
  check_id: 'SC-DS-01',
  overall: identical,
  source: specPath,
  target: iosTokenPath,
  difference_count: differences.length,
  differences
};

if (!report.overall) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(report, null, 2));
