#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const analyticsSourcePath = path.join(
  repoRoot,
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Analytics/AnalyticsClient.swift'
);
const packageDir = path.join(repoRoot, 'ios/MarketplaceClient');
const homeDir = path.join(repoRoot, '.codex-home');
const clangCacheDir = path.join(repoRoot, '.clang-module-cache');

mkdirSync(homeDir, { recursive: true });
mkdirSync(clangCacheDir, { recursive: true });

const requiredEvents = [
  'marketplace.items.viewed',
  'marketplace.items.demand_banner_tapped',
  'marketplace.intents.viewed',
  'marketplace.inbox.viewed',
  'marketplace.proposal.opened',
  'marketplace.proposal.detail.viewed',
  'marketplace.intent.composer.opened',
  'marketplace.intent.edit.opened',
  'marketplace.intent.composer.validated',
  'marketplace.intent.created',
  'marketplace.intent.updated',
  'marketplace.intent.cancelled',
  'marketplace.proposal.accepted',
  'marketplace.proposal.declined',
  'marketplace.timeline.viewed',
  'marketplace.timeline.deposit_confirmed',
  'marketplace.timeline.action_blocked',
  'marketplace.notification.received',
  'marketplace.notification.opened',
  'marketplace.notification.filtered',
  'marketplace.notification.preferences.updated',
  'marketplace.receipt.viewed'
];

function runCoverageTest() {
  return new Promise(resolve => {
    const filter = 'AnalyticsTests/testMarketplaceEventTaxonomyCoverageForItemsAndIntents';
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
  const source = readFileSync(analyticsSourcePath, 'utf8');

  const matrix = requiredEvents.map(eventName => ({
    event: eventName,
    in_schema_catalog: source.includes(`"${eventName}"`)
  }));

  const schemaCatalogPass = matrix.every(entry => entry.in_schema_catalog);
  const coverageTest = await runCoverageTest();

  const overall = schemaCatalogPass && coverageTest.pass;
  const report = {
    check_id: 'SC-AN-01',
    overall,
    required_event_count: requiredEvents.length,
    schema_catalog_pass: schemaCatalogPass,
    coverage_test: coverageTest,
    matrix
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
