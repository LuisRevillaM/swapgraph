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
  const scenarios = [
    {
      scenario: 'items_offline_read_continuity',
      filter: 'OfflineResilienceFeatureTests/testItemsRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      scenario: 'intents_offline_read_continuity',
      filter: 'OfflineResilienceFeatureTests/testIntentsRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      scenario: 'inbox_offline_read_continuity',
      filter: 'OfflineResilienceFeatureTests/testInboxRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      scenario: 'active_offline_read_continuity',
      filter: 'OfflineResilienceFeatureTests/testActiveRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      scenario: 'receipts_offline_read_continuity',
      filter: 'OfflineResilienceFeatureTests/testReceiptsRefreshFallsBackToCachedSnapshotWhenOffline'
    }
  ];

  const checks = [];
  for (const scenario of scenarios) {
    const result = await runSwiftFilter(scenario.filter);
    checks.push({
      scenario: scenario.scenario,
      filter: scenario.filter,
      pass: result.pass,
      exit_code: result.exit_code,
      output_tail: result.output_tail
    });
  }

  const overall = checks.every(check => check.pass);
  const report = {
    check_id: 'SC-RL-01',
    overall,
    scenario_count: checks.length,
    checks
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
