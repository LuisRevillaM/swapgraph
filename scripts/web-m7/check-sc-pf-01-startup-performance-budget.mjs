#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERFORMANCE_BUDGETS, startupBudgetResult } from '../../client/marketplace/src/features/performance/budgets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-pf-01-startup-performance-budget-report.json');

const startupScripts = [
  'client/marketplace/app.js',
  'client/marketplace/src/app/bootstrap.mjs',
  'client/marketplace/src/ui/shell.mjs',
  'client/marketplace/src/ui/screens.mjs',
  'client/marketplace/src/api/apiClient.mjs',
  'client/marketplace/src/state/store.mjs'
];

const startupStyles = [
  'client/marketplace/styles.css',
  'client/marketplace/generated/tokens.css'
];

function bytesForFiles(relativePaths) {
  return relativePaths.map(relativePath => {
    const absolutePath = path.join(repoRoot, relativePath);
    const bytes = statSync(absolutePath).size;
    return {
      file: relativePath,
      bytes
    };
  });
}

function main() {
  const scriptRows = bytesForFiles(startupScripts);
  const styleRows = bytesForFiles(startupStyles);
  const scriptBytes = scriptRows.reduce((sum, row) => sum + row.bytes, 0);
  const styleBytes = styleRows.reduce((sum, row) => sum + row.bytes, 0);
  const totalBytes = scriptBytes + styleBytes;

  const budget = startupBudgetResult({
    scriptBytes,
    styleBytes,
    totalBytes
  });

  const indexHtml = readFileSync(path.join(repoRoot, 'client/marketplace/index.html'), 'utf8');
  const shellChecks = [
    {
      id: 'module_entry_present',
      pass: /<script type="module" src="\.\/app\.js(?:\?[^"]*)?"><\/script>/.test(indexHtml)
    },
    {
      id: 'font_preconnect_present',
      pass: /fonts\.googleapis\.com/.test(indexHtml) && /fonts\.gstatic\.com/.test(indexHtml)
    }
  ];

  const output = {
    check_id: 'SC-PF-01',
    generated_at: new Date().toISOString(),
    budgets: PERFORMANCE_BUDGETS,
    startup_assets: {
      scripts: scriptRows,
      styles: styleRows
    },
    measured_bytes: {
      script: scriptBytes,
      style: styleBytes,
      total: totalBytes
    },
    startup_budget: budget,
    shell_checks: shellChecks,
    pass: budget.pass && shellChecks.every(row => row.pass)
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
