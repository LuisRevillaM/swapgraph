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
  const checklist = [
    {
      item: 'Canonical state labels and progress reflect settlement state machine',
      filter: 'ActiveViewModelFeatureTests/testBuildsCanonicalHeaderProgressForExecutingState'
    },
    {
      item: 'Every state has next action or explicit wait reason',
      filter: 'ActiveViewModelFeatureTests/testEveryStateHasActionOrWaitReasonInvariant'
    },
    {
      item: 'Timeline timestamps are ordered deterministically',
      filter: 'ActiveViewModelFeatureTests/testTimelineEventsSortedByTimestampDescending'
    },
    {
      item: 'Invalid user actions are blocked with explicit reasons',
      filter: 'ActiveViewModelFeatureTests/testEscrowPendingWithoutActorLegShowsExplicitWaitReasonAndDisabledAction'
    },
    {
      item: 'Active push tap routes to active timeline context',
      filter: 'PushNotificationRoutingTests/testActivePushRoutesToActiveTimelineAndEntity'
    },
    {
      item: 'Receipt push tap routes to receipt context',
      filter: 'PushNotificationRoutingTests/testReceiptPushRoutesToReceiptsAndEntity'
    }
  ];

  const checks = [];
  for (const row of checklist) {
    const result = await runSwiftFilter(row.filter);
    checks.push({
      item: row.item,
      filter: row.filter,
      pass: result.pass,
      exit_code: result.exit_code,
      output_tail: result.output_tail
    });
  }

  const eventProof = await runSwiftFilter('ActiveTimelineAnalyticsTests/testEventSequenceForViewAndDepositConfirm');
  const overall = checks.every(check => check.pass) && eventProof.pass;

  const report = {
    check_id: 'SC-UX-03',
    overall,
    journey: 'J3 active timeline clarity',
    checklist: checks,
    event_proof: {
      filter: eventProof.filter,
      pass: eventProof.pass,
      exit_code: eventProof.exit_code,
      expected_sequence: [
        'marketplace.timeline.viewed',
        'marketplace.timeline.deposit_confirmed'
      ],
      output_tail: eventProof.output_tail
    }
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
