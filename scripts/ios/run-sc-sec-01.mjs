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

function keychainPolicyCheck() {
  const source = readFileSync(
    path.join(repoRoot, 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Persistence/KeychainSecureStore.swift'),
    'utf8'
  );
  return {
    file: 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Persistence/KeychainSecureStore.swift',
    requires_device_only_accessibility: source.includes('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly')
  };
}

async function main() {
  const checks = [
    await runSwiftFilter('SecurityHardeningTests/testFileCacheStoreUsesOpaqueFileNamesForSensitiveKeys'),
    await runSwiftFilter('SecurityHardeningTests/testFileCacheStoreMigratesLegacyCacheFileName')
  ];

  const policy = keychainPolicyCheck();
  const overall = checks.every(check => check.pass) && policy.requires_device_only_accessibility;

  const report = {
    check_id: 'SC-SEC-01',
    overall,
    checks: [
      {
        item: 'Sensitive cache keys are stored with opaque filenames',
        filter: checks[0].filter,
        pass: checks[0].pass,
        exit_code: checks[0].exit_code,
        output_tail: checks[0].output_tail
      },
      {
        item: 'Legacy cache key filenames migrate to opaque format',
        filter: checks[1].filter,
        pass: checks[1].pass,
        exit_code: checks[1].exit_code,
        output_tail: checks[1].output_tail
      }
    ],
    keychain_policy: policy
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
