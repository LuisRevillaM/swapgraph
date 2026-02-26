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
      item: 'Inbox renders ranked sections and urgency cues',
      filter: 'InboxViewModelFeatureTests/testBuildsRankingSectionsAndStatusCues'
    },
    {
      item: 'Proposal detail renders explainability primitives',
      filter: 'ProposalDetailViewModelFeatureTests/testExplainabilityPrimitivesAlwaysPresent'
    },
    {
      item: 'Decision actions provide deterministic feedback states',
      filter: 'ProposalDetailViewModelFeatureTests/testAcceptDeclineFeedbackStatesDeterministic'
    },
    {
      item: 'Failure state exposes explicit recovery messaging',
      filter: 'ProposalDetailViewModelFeatureTests/testDeclineFailureMapsRetryableFallbackState'
    },
    {
      item: 'Proposal push tap routes to inbox detail context',
      filter: 'PushNotificationRoutingTests/testProposalPushRoutesToInboxAndEntity'
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

  const eventProof = await runSwiftFilter('ProposalFunnelAnalyticsTests/testEventSequenceForOpenAndAccept');
  const overall = checks.every(check => check.pass) && eventProof.pass;

  const report = {
    check_id: 'SC-UX-02',
    overall,
    journey: 'J2 proposal decision clarity',
    checklist: checks,
    event_proof: {
      filter: eventProof.filter,
      pass: eventProof.pass,
      exit_code: eventProof.exit_code,
      expected_sequence: [
        'marketplace.inbox.viewed',
        'marketplace.proposal.opened',
        'marketplace.proposal.detail.viewed',
        'marketplace.proposal.accepted'
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
