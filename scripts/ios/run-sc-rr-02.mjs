#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
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
  const drillChecks = [
    {
      step: 'Disable inbox route and verify shell fallback remains usable',
      result: await runSwiftFilter('ReleaseReadinessTests/testRollbackDrillFallsBackWhenInboxRouteDisabled')
    },
    {
      step: 'Suppress push routing through preferences without route corruption',
      result: await runSwiftFilter('ReleaseReadinessTests/testRollbackDrillCanSuppressPushRoutingViaPreferences')
    },
    {
      step: 'Offline fallback path remains available for read continuity',
      result: await runSwiftFilter('OfflineResilienceFeatureTests/testItemsRefreshFallsBackToCachedSnapshotWhenOffline')
    }
  ];

  const rollbackTargetArtifacts = [
    'artifacts/milestones/IOS-M6/latest/sc-rl-01.json',
    'artifacts/milestones/IOS-M6/latest/sc-rl-03.json',
    'artifacts/milestones/IOS-M6/latest/sc-api-01.json'
  ];

  const rollbackTargetEvidence = rollbackTargetArtifacts.map(relative => ({
    file: relative,
    exists: existsSync(path.join(repoRoot, relative))
  }));

  const overall = drillChecks.every(check => check.result.pass)
    && rollbackTargetEvidence.every(item => item.exists);

  const report = {
    check_id: 'SC-RR-02',
    overall,
    rollback_drill: drillChecks.map(check => ({
      step: check.step,
      filter: check.result.filter,
      pass: check.result.pass,
      exit_code: check.result.exit_code,
      output_tail: check.result.output_tail
    })),
    rollback_target_evidence: rollbackTargetEvidence
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
