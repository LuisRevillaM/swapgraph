#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index < process.argv.length - 1) {
    return process.argv[index + 1];
  }
  return fallback;
}

function parseJson(filePath) {
  const text = readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

async function main() {
  const evidenceDir = argValue(
    '--evidence-dir',
    path.join(repoRoot, 'artifacts/milestones/IOS-M7/latest')
  );

  const requiredJson = [
    'sc-ax-01.json',
    'sc-ax-02.json',
    'sc-ax-03.json',
    'sc-pf-01.json',
    'sc-pf-02.json',
    'sc-pf-03.json',
    'sc-sec-01.json',
    'sc-sec-02.json',
    'sc-sec-03.json',
    'sc-ux-02.json',
    'sc-ux-03.json',
    'sc-ux-04.json',
    'sc-an-01.json',
    'sc-an-02.json',
    'sc-rl-01.json',
    'sc-rl-03.json',
    'sc-api-01.json',
    'sc-api-03.json',
    'sc-api-04.json',
    'sc-ds-01.json',
    'sc-ds-02.json'
  ];

  const checklist = requiredJson.map(filename => {
    const fullPath = path.join(evidenceDir, filename);
    if (!existsSync(fullPath)) {
      return {
        file: filename,
        exists: false,
        overall: false
      };
    }

    const report = parseJson(fullPath);
    return {
      file: filename,
      exists: true,
      overall: Boolean(report.overall)
    };
  });

  const swiftTestPath = path.join(evidenceDir, 'swift-test.log');
  const swiftTestPresent = existsSync(swiftTestPath);
  let swiftTestPass = false;
  if (swiftTestPresent) {
    const log = readFileSync(swiftTestPath, 'utf8');
    swiftTestPass = log.includes('0 failures');
  }

  const overall = checklist.every(item => item.exists && item.overall) && swiftTestPass;
  const report = {
    check_id: 'SC-RR-01',
    overall,
    evidence_dir: evidenceDir,
    checklist,
    swift_test: {
      file: 'swift-test.log',
      exists: swiftTestPresent,
      pass: swiftTestPass
    }
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
