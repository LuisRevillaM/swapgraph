#!/usr/bin/env node
import { createRuntimeApiServer } from '../src/server/runtimeApiServer.mjs';

const portRaw = process.env.PORT ?? '3005';
const port = Number.parseInt(String(portRaw), 10);
if (!Number.isFinite(port) || port <= 0) {
  console.error(`Invalid PORT: ${portRaw}`);
  process.exit(2);
}

const host = process.env.HOST ?? '127.0.0.1';
const storePath = process.env.STATE_FILE;
const stateBackend = process.env.STATE_BACKEND ?? 'json';
let runtime = null;

async function main() {
  runtime = createRuntimeApiServer({ host, port, storePath, stateBackend });
  await runtime.listen();
  console.log(`[runtime-api] listening on http://${runtime.host}:${runtime.port}`);
  console.log(`[runtime-api] state backend: ${runtime.storeBackend} (${runtime.persistenceMode})`);
  console.log(`[runtime-api] state file: ${runtime.storePath}`);
}

main().catch(err => {
  console.error('[runtime-api] failed to start:', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (!runtime) {
      process.exit(0);
    }
    try {
      await runtime.close();
      process.exit(0);
    } catch (err) {
      console.error('[runtime-api] failed to close cleanly:', err);
      process.exit(1);
    }
  });
}
