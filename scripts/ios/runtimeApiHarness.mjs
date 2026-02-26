import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export function actorHeaders(actorType, actorId, scopes = []) {
  const headers = {
    'x-actor-type': actorType,
    'x-actor-id': actorId
  };
  if (scopes.length > 0) {
    headers['x-auth-scopes'] = scopes.join(',');
  }
  return headers;
}

export async function startRuntimeApi({ port, stateFile }) {
  const child = spawn(
    'node',
    ['scripts/run-api-server.mjs'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        STATE_FILE: stateFile,
        STATE_BACKEND: 'json'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let logs = '';
  child.stdout.on('data', chunk => {
    logs += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    logs += chunk.toString();
  });

  const baseURL = `http://127.0.0.1:${port}`;
  let ready = false;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/healthz`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // retry
    }
    await delay(150);
  }

  if (!ready) {
    await stopRuntimeApi(child);
    throw new Error(`runtime api failed to boot on ${baseURL}\n${logs}`);
  }

  return {
    baseURL,
    child,
    getLogs: () => logs
  };
}

export async function stopRuntimeApi(child) {
  if (!child || child.killed) return;

  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 800);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function requestJson(baseURL, endpoint, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseURL}${endpoint}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let parsedBody;
  try {
    parsedBody = text ? JSON.parse(text) : null;
  } catch {
    parsedBody = { _raw: text };
  }

  return {
    status: response.status,
    body: parsedBody,
    headers: Object.fromEntries(response.headers.entries())
  };
}

export function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}
