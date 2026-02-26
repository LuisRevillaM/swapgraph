#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index < process.argv.length - 1) {
    return process.argv[index + 1];
  }
  return fallback;
}

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

function gatePass(evidenceDir, filename) {
  const fullPath = path.join(evidenceDir, filename);
  if (!existsSync(fullPath)) {
    return false;
  }
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  return Boolean(parsed.overall);
}

async function main() {
  const evidenceDir = argValue(
    '--evidence-dir',
    path.join(repoRoot, 'artifacts/milestones/IOS-M7/latest')
  );

  const fiveTabTest = await runSwiftFilter('AppShellUISmokeTests/testBootsWithFiveTabsWhenAllEnabled');
  const firstIntentTest = await runSwiftFilter('IntentsViewModelFeatureTests/testJourneyTraceCapturesFirstIntentAndMedianUnderSixtySeconds');

  const parityItems = [
    {
      id: 'PC-01',
      item: 'Five-tab IA parity',
      pass: fiveTabTest.pass
    },
    {
      id: 'PC-02',
      item: 'First-intent structured flow parity',
      pass: firstIntentTest.pass
    },
    {
      id: 'PC-03',
      item: 'System always running model parity',
      pass: gatePass(evidenceDir, 'sc-ux-02.json')
    },
    {
      id: 'PC-04',
      item: 'Proposal explainability parity',
      pass: gatePass(evidenceDir, 'sc-ux-02.json')
    },
    {
      id: 'PC-05',
      item: 'Accept/decline semantics parity',
      pass: gatePass(evidenceDir, 'sc-api-03.json')
    },
    {
      id: 'PC-06',
      item: 'Active timeline wait-reason parity',
      pass: gatePass(evidenceDir, 'sc-ux-03.json')
    },
    {
      id: 'PC-07',
      item: 'Receipt metadata parity',
      pass: gatePass(evidenceDir, 'sc-ux-04.json')
    },
    {
      id: 'PC-08',
      item: 'Error envelope rendering parity',
      pass: gatePass(evidenceDir, 'sc-api-04.json')
    },
    {
      id: 'PC-09',
      item: 'Analytics taxonomy parity',
      pass: gatePass(evidenceDir, 'sc-an-01.json') && gatePass(evidenceDir, 'sc-an-02.json')
    },
    {
      id: 'PC-10',
      item: 'Offline stale-banner parity',
      pass: gatePass(evidenceDir, 'sc-rl-03.json')
    },
    {
      id: 'PC-11',
      item: 'Security posture parity',
      pass: gatePass(evidenceDir, 'sc-sec-01.json')
        && gatePass(evidenceDir, 'sc-sec-02.json')
        && gatePass(evidenceDir, 'sc-sec-03.json')
    },
    {
      id: 'PC-12',
      item: 'Accessibility baseline parity',
      pass: gatePass(evidenceDir, 'sc-ax-01.json')
        && gatePass(evidenceDir, 'sc-ax-02.json')
        && gatePass(evidenceDir, 'sc-ax-03.json')
    }
  ];

  const overall = parityItems.every(row => row.pass);
  const report = {
    check_id: 'SC-RR-03',
    overall,
    evidence_dir: evidenceDir,
    parity_items: parityItems,
    targeted_tests: [
      {
        filter: fiveTabTest.filter,
        pass: fiveTabTest.pass,
        exit_code: fiveTabTest.exit_code,
        output_tail: fiveTabTest.output_tail
      },
      {
        filter: firstIntentTest.filter,
        pass: firstIntentTest.pass,
        exit_code: firstIntentTest.exit_code,
        output_tail: firstIntentTest.output_tail
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
