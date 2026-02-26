#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { disableServiceWorkerForRollback, serviceWorkerMode } from '../../client/marketplace/src/app/serviceWorkerControl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const appPath = path.join(repoRoot, 'client/marketplace/app.js');
const swPath = path.join(repoRoot, 'client/marketplace/sw.js');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-rr-02-rollback-drill-viability-report.json');

async function main() {
  const modeByQuery = serviceWorkerMode({
    location: { search: '?sw=off' },
    localStorage: { getItem: () => null }
  });

  const rollbackResult = await disableServiceWorkerForRollback({
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [
          { unregister: async () => true },
          { unregister: async () => true }
        ]
      }
    },
    caches: {
      keys: async () => ['swapgraph-marketplace-shell-v1', 'swapgraph-marketplace-shell-v0', 'other-cache'],
      delete: async key => key.startsWith('swapgraph-marketplace-shell')
    }
  });

  const appSource = readFileSync(appPath, 'utf8');
  const swSource = readFileSync(swPath, 'utf8');

  const checklist = [
    {
      id: 'query_can_disable_sw_registration',
      pass: modeByQuery === 'off'
    },
    {
      id: 'rollback_unregisters_service_workers',
      pass: rollbackResult.unregistered === 2
    },
    {
      id: 'rollback_clears_shell_caches',
      pass: rollbackResult.cachesCleared === 2
    },
    {
      id: 'app_boot_checks_sw_mode_flag',
      pass: /serviceWorkerMode\(window\)\s*===\s*'off'/.test(appSource)
        && /disableServiceWorkerForRollback\(window\)/.test(appSource)
    },
    {
      id: 'service_worker_is_versioned_and_has_network_fallback',
      pass: /CACHE_NAME/.test(swSource)
        && /skipWaiting/.test(swSource)
        && /clients\.claim/.test(swSource)
        && /caches\.match\('\/index\.html'\)/.test(swSource)
    }
  ];

  const output = {
    check_id: 'SC-RR-02',
    generated_at: new Date().toISOString(),
    rollback_result: rollbackResult,
    checklist,
    pass: checklist.every(row => row.pass)
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
