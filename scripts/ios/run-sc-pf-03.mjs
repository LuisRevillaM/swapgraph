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
  const longListBudget = await runSwiftFilter('PerformanceBudgetTests/testLongListRefreshBudgetForInbox');
  const lazyContainers = await runSwiftFilter('PerformanceBudgetTests/testLongListSurfacesUseLazyContainers');
  const overall = longListBudget.pass && lazyContainers.pass;

  const report = {
    check_id: 'SC-PF-03',
    overall,
    budget: 'long_list_scroll',
    checks: [
      {
        item: 'Long-list refresh processing stays within budget',
        filter: longListBudget.filter,
        pass: longListBudget.pass,
        exit_code: longListBudget.exit_code,
        output_tail: longListBudget.output_tail
      },
      {
        item: 'Long-list surfaces use lazy stack/grid containers',
        filter: lazyContainers.filter,
        pass: lazyContainers.pass,
        exit_code: lazyContainers.exit_code,
        output_tail: lazyContainers.output_tail
      }
    ]
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
