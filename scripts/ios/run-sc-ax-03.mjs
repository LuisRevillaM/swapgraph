#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const packageDir = path.join(repoRoot, 'ios/MarketplaceClient');
const homeDir = path.join(repoRoot, '.codex-home');
const clangCacheDir = path.join(repoRoot, '.clang-module-cache');

mkdirSync(homeDir, { recursive: true });
mkdirSync(clangCacheDir, { recursive: true });

function runSwiftFilter(filter) {
  return new Promise(resolve => {
    const child = spawn(
      'swift',
      ['test', '--filter', filter],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          HOME: homeDir,
          CLANG_MODULE_CACHE_PATH: clangCacheDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
    });

    child.on('close', code => {
      const lines = output.trim().split('\n').filter(Boolean);
      resolve({
        filter,
        pass: code === 0,
        exit_code: code,
        output_tail: lines.slice(-25)
      });
    });
  });
}

async function main() {
  const checks = [
    {
      item: 'Touch target baseline constant is 44 points',
      filter: 'AccessibilityFeatureTests/testTouchTargetBaselineIsFortyFourPoints'
    },
    {
      item: 'Small controls are elevated to minimum touch target',
      filter: 'AccessibilityFeatureTests/testSmallControlsPromotedToMinimumTouchTarget'
    }
  ];

  const results = [];
  for (const check of checks) {
    const result = await runSwiftFilter(check.filter);
    results.push({
      item: check.item,
      filter: check.filter,
      pass: result.pass,
      exit_code: result.exit_code,
      output_tail: result.output_tail
    });
  }

  const overall = results.every(result => result.pass);
  const report = {
    check_id: 'SC-AX-03',
    overall,
    checks: results
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
