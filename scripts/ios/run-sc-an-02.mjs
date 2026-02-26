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
  const orderedScenarios = [
    {
      scenario: 'open_to_accept',
      filter: 'ProposalFunnelAnalyticsTests/testEventSequenceForOpenAndAccept',
      expected_sequence: [
        'marketplace.inbox.viewed',
        'marketplace.proposal.opened',
        'marketplace.proposal.detail.viewed',
        'marketplace.proposal.accepted'
      ]
    },
    {
      scenario: 'open_to_decline',
      filter: 'ProposalFunnelAnalyticsTests/testEventSequenceForOpenAndDecline',
      expected_sequence: [
        'marketplace.inbox.viewed',
        'marketplace.proposal.opened',
        'marketplace.proposal.detail.viewed',
        'marketplace.proposal.declined'
      ]
    },
    {
      scenario: 'timeline_view_to_deposit',
      filter: 'ActiveTimelineAnalyticsTests/testEventSequenceForViewAndDepositConfirm',
      expected_sequence: [
        'marketplace.timeline.viewed',
        'marketplace.timeline.deposit_confirmed'
      ]
    }
  ];

  const checks = [];
  for (const scenario of orderedScenarios) {
    const result = await runSwiftFilter(scenario.filter);
    checks.push({
      scenario: scenario.scenario,
      filter: scenario.filter,
      pass: result.pass,
      exit_code: result.exit_code,
      expected_sequence: scenario.expected_sequence,
      output_tail: result.output_tail
    });
  }

  const overall = checks.every(check => check.pass);
  const report = {
    check_id: 'SC-AN-02',
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
