import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = 4179;
const BASE_URL = `http://${HOST}:${PORT}`;

async function waitForServer(url, timeoutMs = 7000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`server did not become ready: ${url}`);
}

test('marketplace shell serves mobile-first app entry and tab config', async () => {
  const proc = spawn('node', ['scripts/run-marketplace-client.mjs'], {
    cwd: '/Users/luisrevilla/code/swapgraph',
    env: {
      ...process.env,
      CLIENT_HOST: HOST,
      CLIENT_PORT: String(PORT),
      RUNTIME_SERVICE_URL: 'http://127.0.0.1:3005'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(`${BASE_URL}/index.html`);

    const indexResponse = await fetch(`${BASE_URL}/index.html`);
    const indexHtml = await indexResponse.text();
    assert.equal(indexResponse.status, 200);
    assert.match(indexHtml, /id="app-root"/);
    assert.match(indexHtml, /generated\/tokens\.css/);

    const tabsResponse = await fetch(`${BASE_URL}/src/app/tabs.mjs`);
    const tabsText = await tabsResponse.text();
    assert.equal(tabsResponse.status, 200);
    assert.match(tabsText, /Items/);
    assert.match(tabsText, /Intents/);
    assert.match(tabsText, /Inbox/);
    assert.match(tabsText, /Active/);
    assert.match(tabsText, /Receipts/);
  } finally {
    proc.kill('SIGTERM');
  }
});
