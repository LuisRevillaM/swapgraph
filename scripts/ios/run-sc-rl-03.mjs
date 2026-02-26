#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
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

function staleBannerChecklist() {
  const files = [
    'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsView.swift',
    'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsView.swift',
    'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Inbox/InboxView.swift',
    'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveView.swift',
    'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift'
  ];

  return files.map(file => {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    return {
      file,
      has_stale_banner_view: source.includes('StaleDataBannerView')
    };
  });
}

async function main() {
  const staleStateTests = [
    {
      item: 'items surface exposes stale offline disclosure',
      filter: 'OfflineResilienceFeatureTests/testItemsRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      item: 'intents surface exposes stale offline disclosure',
      filter: 'OfflineResilienceFeatureTests/testIntentsRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      item: 'inbox surface exposes stale offline disclosure',
      filter: 'OfflineResilienceFeatureTests/testInboxRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      item: 'active surface exposes stale offline disclosure',
      filter: 'OfflineResilienceFeatureTests/testActiveRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      item: 'receipts surface exposes stale offline disclosure',
      filter: 'OfflineResilienceFeatureTests/testReceiptsRefreshFallsBackToCachedSnapshotWhenOffline'
    },
    {
      item: 'notification category preference suppresses disallowed routing',
      filter: 'PushNotificationRoutingTests/testFiltersPushWhenCategoryIsDisabled'
    },
    {
      item: 'notification urgency preference suppresses low-priority routing',
      filter: 'PushNotificationRoutingTests/testFiltersPushWhenUrgencyIsBelowPreferenceThreshold'
    }
  ];

  const checks = [];
  for (const row of staleStateTests) {
    const result = await runSwiftFilter(row.filter);
    checks.push({
      item: row.item,
      filter: row.filter,
      pass: result.pass,
      exit_code: result.exit_code,
      output_tail: result.output_tail
    });
  }

  const uiChecklist = staleBannerChecklist();
  const uiChecklistPass = uiChecklist.every(item => item.has_stale_banner_view);
  const overall = checks.every(check => check.pass) && uiChecklistPass;

  const report = {
    check_id: 'SC-RL-03',
    overall,
    stale_state_checks: checks,
    ui_stale_banner_checklist: uiChecklist,
    ui_stale_banner_checklist_pass: uiChecklistPass
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
