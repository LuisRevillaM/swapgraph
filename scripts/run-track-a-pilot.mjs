#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { trackAActorAlias, trackAActorIds, trackAAssetLabel } from '../client/marketplace/src/pilot/trackATheme.mjs';

function readPort(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

const apiHost = process.env.TRACK_A_API_HOST ?? '127.0.0.1';
const apiPort = readPort('TRACK_A_API_PORT', 3005);
const clientHost = process.env.TRACK_A_CLIENT_HOST ?? '127.0.0.1';
const clientPort = readPort('TRACK_A_CLIENT_PORT', 4173);
const partnerId = String(process.env.TRACK_A_PARTNER_ID ?? 'partner_demo').trim() || 'partner_demo';
const resetOnStart = process.env.TRACK_A_RESET !== '0';
const runtimeUrl = `http://${apiHost}:${apiPort}`;
const stateFile = process.env.TRACK_A_STATE_FILE ?? 'data/runtime-api-track-a.json';
const actorIdsEnv = process.env.TRACK_A_ACTOR_IDS ?? '';
const FIXTURE_ACTOR_IDS = Object.freeze(trackAActorIds());
const FIXTURE_ACTOR_SET = new Set(FIXTURE_ACTOR_IDS);
const TRACK_A_ITEM_IDS = Object.freeze(['assetA', 'assetB', 'assetC', 'assetD', 'assetE', 'assetF']);

let apiChild = null;
let clientChild = null;
let shuttingDown = false;

function parseActorIds(raw) {
  const parsed = String(raw ?? '')
    .split(',')
    .map(value => String(value).trim())
    .filter(Boolean);
  if (parsed.length === 0) return [...FIXTURE_ACTOR_IDS];

  const unique = Array.from(new Set(parsed));
  const invalid = unique.filter(value => !FIXTURE_ACTOR_SET.has(value));
  if (invalid.length > 0) {
    throw new Error(
      `TRACK_A_ACTOR_IDS contains unsupported actor ids (${invalid.join(',')}). ` +
      `Allowed fixture actors: ${FIXTURE_ACTOR_IDS.join(',')}`
    );
  }

  const missing = FIXTURE_ACTOR_IDS.filter(value => !unique.includes(value));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[track-a] warning: actor ids missing seeded personas (${missing.join(',')}); ` +
      'some fixture proposals may not be completable.'
    );
  }

  return unique;
}

function spawnChild(name, args, extraEnv = {}) {
  const child = spawn('node', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  child.on('error', error => {
    // eslint-disable-next-line no-console
    console.error(`[track-a] ${name} failed to start: ${error.message}`);
    void shutdown(1);
  });

  child.on('exit', code => {
    if (shuttingDown) return;
    // eslint-disable-next-line no-console
    console.error(`[track-a] ${name} exited unexpectedly (code=${code ?? 'null'})`);
    void shutdown(typeof code === 'number' ? code : 1);
  });

  return child;
}

async function assertPortAvailable({ host, port, envName }) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', error => {
      server.close(() => {
        reject(new Error(`Port ${host}:${port} is in use. Set ${envName} to override.`));
      });
    });
    server.listen(port, host, () => {
      server.close(resolve);
    });
  });
}

async function waitForApiReady(timeoutMs = 30_000) {
  const startedAt = Date.now();
  const healthUrl = `${runtimeUrl}/healthz`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // ignore while warming up
    }
    await sleep(500);
  }

  throw new Error(`API did not become ready within ${timeoutMs}ms`);
}

async function seedFixtures() {
  const response = await fetch(`${runtimeUrl}/dev/seed/m5`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reset: resetOnStart,
      partner_id: partnerId
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`failed to seed m5 fixtures (${response.status}): ${body}`);
  }

  const payload = await response.json();
  // eslint-disable-next-line no-console
  console.log(
    `[track-a] seeded fixtures: intents=${payload.seeded_intents ?? 0}, proposals=${payload.seeded_proposals ?? 0}, reset=${payload.reset_applied === true}`
  );
}

function terminateChild(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateChild(clientChild);
  terminateChild(apiChild);
  await sleep(250);
  process.exit(code);
}

async function main() {
  const actorIds = parseActorIds(actorIdsEnv);

  await assertPortAvailable({ host: apiHost, port: apiPort, envName: 'TRACK_A_API_PORT' });
  await assertPortAvailable({ host: clientHost, port: clientPort, envName: 'TRACK_A_CLIENT_PORT' });

  // eslint-disable-next-line no-console
  console.log('[track-a] starting UX-only pilot stack (Steam integration disabled)');
  // eslint-disable-next-line no-console
  console.log(`[track-a] api=${runtimeUrl} client=http://${clientHost}:${clientPort}`);
  // eslint-disable-next-line no-console
  console.log(`[track-a] state_file=${stateFile}`);
  // eslint-disable-next-line no-console
  console.log(`[track-a] actors=${actorIds.join(',')}`);

  apiChild = spawnChild('runtime-api', ['scripts/run-api-server.mjs'], {
    HOST: apiHost,
    PORT: String(apiPort),
    STATE_FILE: stateFile,
    INTEGRATION_ENABLED: '0'
  });

  await waitForApiReady();
  await seedFixtures();

  clientChild = spawnChild('marketplace-client', ['scripts/run-marketplace-client.mjs'], {
    CLIENT_HOST: clientHost,
    CLIENT_PORT: String(clientPort),
    RUNTIME_SERVICE_URL: runtimeUrl,
    INTEGRATION_ENABLED: '0'
  });

  // eslint-disable-next-line no-console
  console.log('[track-a] ready');
  // eslint-disable-next-line no-console
  console.log(`[track-a] open http://${clientHost}:${clientPort}`);
  // eslint-disable-next-line no-console
  console.log('[track-a] participant links');
  actorIds.forEach((actorId, index) => {
    const label = `P${String(index + 1).padStart(2, '0')}`;
    const link = `http://${clientHost}:${clientPort}/?actor_id=${encodeURIComponent(actorId)}`;
    const alias = trackAActorAlias(actorId);
    // eslint-disable-next-line no-console
    console.log(`[track-a]   ${label} (${actorId}${alias ? ` · ${alias}` : ''}): ${link}`);
  });
  // eslint-disable-next-line no-console
  console.log('[track-a] themed item universe');
  TRACK_A_ITEM_IDS.forEach(itemId => {
    const label = trackAAssetLabel(itemId) ?? itemId;
    // eslint-disable-next-line no-console
    console.log(`[track-a]   ${itemId}: ${label}`);
  });
  // eslint-disable-next-line no-console
  console.log('[track-a] press Ctrl+C to stop both services');
}

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error(`[track-a] startup failed: ${error.message}`);
  void shutdown(1);
});
