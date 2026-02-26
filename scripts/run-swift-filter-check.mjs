#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const parsed = {
    checkId: null,
    items: []
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--check-id' && next) {
      parsed.checkId = next;
      i += 1;
      continue;
    }

    if (token === '--item' && next) {
      const splitIndex = next.indexOf('::');
      if (splitIndex === -1) {
        throw new Error(`--item requires format \"label::FilterName\"; got: ${next}`);
      }
      parsed.items.push({
        label: next.slice(0, splitIndex),
        filter: next.slice(splitIndex + 2)
      });
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.checkId) {
    throw new Error('--check-id is required');
  }

  if (parsed.items.length === 0) {
    throw new Error('At least one --item is required');
  }

  return parsed;
}

function runSwiftFilter({ packageDir, homeDir, clangCacheDir, filter }) {
  return new Promise((resolve) => {
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
        pass: code === 0,
        exit_code: code,
        output_tail: lines.slice(-25)
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const packageDir = path.join(repoRoot, 'ios/MarketplaceClient');
  const homeDir = path.join(repoRoot, '.codex-home');
  const clangCacheDir = path.join(repoRoot, '.clang-module-cache');

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(clangCacheDir, { recursive: true });

  const checks = [];
  for (const item of args.items) {
    const result = await runSwiftFilter({
      packageDir,
      homeDir,
      clangCacheDir,
      filter: item.filter
    });

    checks.push({
      item: item.label,
      filter: item.filter,
      pass: result.pass,
      exit_code: result.exit_code,
      output_tail: result.output_tail
    });
  }

  const overall = checks.every(check => check.pass);
  const report = {
    check_id: args.checkId,
    overall,
    checks
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
