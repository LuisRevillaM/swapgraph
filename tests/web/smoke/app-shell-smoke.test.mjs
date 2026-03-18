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

test('marketplace shell serves vnext-only agent barter entry and discovery surface', async () => {
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

    const shellResponse = await fetch(`${BASE_URL}/app.js`);
    const shellText = await shellResponse.text();
    assert.equal(shellResponse.status, 200);
    assert.match(shellText, /mountMarketplaceVNext/);
    assert.doesNotMatch(shellText, /bootstrapMarketplaceClient/);
    assert.doesNotMatch(shellText, /isLegacyMarketplaceHashRoute/);

    const tabsResponse = await fetch(`${BASE_URL}/src/app/tabs.mjs`);
    const tabsText = await tabsResponse.text();
    assert.equal(tabsResponse.status, 200);
    assert.match(tabsText, /Items/);
    assert.match(tabsText, /Intents/);
    assert.match(tabsText, /Inbox/);
    assert.match(tabsText, /Active/);
    assert.match(tabsText, /Receipts/);

    const vnextResponse = await fetch(`${BASE_URL}/src/vnext/app.mjs`);
    const vnextText = await vnextResponse.text();
    assert.equal(vnextResponse.status, 200);
    assert.match(vnextText, /Your agent can barter without finding a direct match\./);
    assert.match(vnextText, /Agent Barter Network/);
    assert.match(vnextText, /Open API discovery/);
    assert.match(vnextText, /Open OpenAPI/);
    assert.match(vnextText, /openapi\.json/);
    assert.match(vnextText, /Direct offer/);
    assert.doesNotMatch(vnextText, /github\.com\/LuisRevillaM\/swapgraph\/blob/);
    assert.match(vnextText, /Operator queue/);
    assert.match(vnextText, /market:moderate/);
    assert.match(vnextText, /Case evidence/);
    assert.match(vnextText, /Resolution history/);
    assert.match(vnextText, /Apply filters/);
  } finally {
    proc.kill('SIGTERM');
  }
});
