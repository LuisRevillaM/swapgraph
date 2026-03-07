import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const outDir = process.env.OUT_DIR ?? path.join(process.cwd(), 'artifacts', 'market-vnext-five-agent-simulation');
mkdirSync(outDir, { recursive: true });
const port = process.env.MARKET_SIM_PORT ?? '3110';
const stateFile = path.join(outDir, 'simulation.json');
const root = process.cwd();

const server = spawn('node', ['scripts/run-api-server.mjs'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: port, AUTHZ_ENFORCE: '1', STATE_BACKEND: 'json', STATE_FILE: stateFile, STORE_PATH: stateFile },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk.toString('utf8'); });
server.stderr.on('data', chunk => { serverLog += chunk.toString('utf8'); });

async function waitForServer() {
  const started = Date.now();
  while ((Date.now() - started) < 10000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/market/feed`, { headers: { 'x-actor-type': 'user', 'x-actor-id': 'sim-health', 'x-auth-scopes': 'market:read' } });
      if (res.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('simulation server did not become ready');
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/market-cli.mjs', ...args], {
      cwd: root,
      env: { ...process.env, SWAPGRAPH_BASE_URL: `http://127.0.0.1:${port}`, SWAPGRAPH_SCOPES: 'market:read market:write payment_proofs:write receipts:read execution_grants:write execution_grants:consume' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`cli failed code=${code} stderr=${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

try {
  await waitForServer();
  const direct = await runCli(['smoke', 'direct']);
  const capability = await runCli(['smoke', 'capability']);
  const proof = await runCli(['smoke', 'proof']);
  const multi = await runCli(['smoke', 'multi-agent']);
  const artifact = {
    actors: ['buyer_agent', 'seller_agent', 'capability_agent', 'proof_buyer', 'proof_seller'],
    flows: [direct, capability, proof],
    aggregate: multi
  };
  writeFileSync(path.join(outDir, 'five_agent_simulation.json'), JSON.stringify(artifact, null, 2));
  writeFileSync(path.join(outDir, 'server.log'), serverLog);
  console.log(JSON.stringify({ ok: true, artifact }, null, 2));
} finally {
  server.kill('SIGTERM');
}
