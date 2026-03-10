#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const baseUrl = String(process.env.SWAPGRAPH_BASE_URL ?? 'https://swapgraph-market-vnext-api.onrender.com').replace(/\/+$/g, '');
const outDir = process.env.OUT_DIR ?? path.join(cwd, 'docs/evidence/market-vnext');
const outFile = path.join(outDir, 'hosted-production-experiment.latest.json');

function run(label, args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, SWAPGRAPH_BASE_URL: baseUrl, MARKET_BASE_URL: baseUrl, ...env },
    encoding: 'utf8'
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || 'null');
  } catch {
    parsed = null;
  }
  return {
    label,
    command: `node ${args.join(' ')}`,
    status: result.status,
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed
  };
}

const startedAt = new Date().toISOString();
const seed = run('seed', ['scripts/seed-market-agent-personas.mjs']);
const marketLoop = run('market_loop', ['scripts/run-agent-market-loop.mjs']);
const adversaryLoop = run('adversary_loop', ['scripts/run-agent-adversary-loop.mjs']);
const stats = run('stats', ['-e', `fetch(${JSON.stringify(`${baseUrl}/market/stats`)})
  .then(r => r.json())
  .then(v => process.stdout.write(JSON.stringify(v)))`]);

const ok = seed.ok && marketLoop.ok && adversaryLoop.ok && stats.ok;
const report = {
  ok,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  base_url: baseUrl,
  steps: [seed, marketLoop, adversaryLoop, stats].map(step => ({
    label: step.label,
    command: step.command,
    status: step.status,
    ok: step.ok,
    parsed: step.parsed
  })),
  stats: stats.parsed?.stats ?? null
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(ok ? 0 : 1);
