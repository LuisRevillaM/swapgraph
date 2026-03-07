import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const root = process.cwd();
const port = process.env.M145_PORT ?? '3105';
const stateFile = path.join(outDir, 'market_cli_smoke.json');
const server = spawn('node', ['scripts/run-api-server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    AUTHZ_ENFORCE: '1',
    STATE_BACKEND: 'json',
    STATE_FILE: stateFile,
    STORE_PATH: stateFile
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk.toString('utf8'); });
server.stderr.on('data', chunk => { serverLog += chunk.toString('utf8'); });

async function waitForServer() {
  const start = Date.now();
  while ((Date.now() - start) < 10000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/market/feed`, { headers: { 'x-actor-type': 'user', 'x-actor-id': 'health', 'x-auth-scopes': 'market:read' } });
      if (res.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('server did not become ready');
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/market-cli.mjs', ...args], {
      cwd: root,
      env: {
        ...process.env,
        SWAPGRAPH_BASE_URL: `http://127.0.0.1:${port}`,
        SWAPGRAPH_SCOPES: 'market:read market:write payment_proofs:write receipts:read execution_grants:write execution_grants:consume'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`cli failed code=${code} stderr=${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

try {
  await waitForServer();
  const direct = JSON.parse((await runCli(['smoke', 'direct'])).stdout);
  const capability = JSON.parse((await runCli(['smoke', 'capability'])).stdout);
  const proof = JSON.parse((await runCli(['smoke', 'proof'])).stdout);
  const multi = JSON.parse((await runCli(['smoke', 'multi-agent'])).stdout);
  const output = { direct, capability, proof, multi };
  writeFileSync(path.join(outDir, 'market_agent_cli_smoke_output.json'), JSON.stringify(output, null, 2));
  writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ ok: true, milestone: 'M145', output }, null, 2));
  console.log(JSON.stringify({ ok: true, milestone: 'M145', output }, null, 2));
} finally {
  server.kill('SIGTERM');
  writeFileSync(path.join(outDir, 'server.log'), serverLog);
}
