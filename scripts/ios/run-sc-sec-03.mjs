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

function redactionUsageCheck() {
  const source = readFileSync(
    path.join(repoRoot, 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/API/MarketplaceAPIClient.swift'),
    'utf8'
  );
  return {
    file: 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/API/MarketplaceAPIClient.swift',
    uses_redactor_for_transport_errors: source.includes('SecurityLogRedactor.redact')
  };
}

async function main() {
  const redactorTest = await runSwiftFilter('SecurityHardeningTests/testSecurityLogRedactorRemovesSensitiveValues');
  const usage = redactionUsageCheck();

  const overall = redactorTest.pass && usage.uses_redactor_for_transport_errors;
  const report = {
    check_id: 'SC-SEC-03',
    overall,
    checks: [
      {
        item: 'Security log redactor removes bearer/idempotency/correlation values',
        filter: redactorTest.filter,
        pass: redactorTest.pass,
        exit_code: redactorTest.exit_code,
        output_tail: redactorTest.output_tail
      }
    ],
    source_usage: usage
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
