#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const baseUrl = String(process.env.SWAPGRAPH_BASE_URL ?? 'https://swapgraph-market-vnext-api.onrender.com').replace(/\/+$/g, '');
const intervalMs = Math.max(60_000, Number.parseInt(String(process.env.MARKET_OPERATOR_INTERVAL_MS ?? '900000'), 10) || 900000);
const adversaryEvery = Math.max(1, Number.parseInt(String(process.env.MARKET_OPERATOR_ADVERSARY_EVERY ?? '6'), 10) || 6);
const runOnce = process.env.MARKET_OPERATOR_ONCE === '1';

function runNodeScript(label, script) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWAPGRAPH_BASE_URL: baseUrl,
      MARKET_BASE_URL: baseUrl
    },
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
    script,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: result.status,
    ok: result.status === 0,
    parsed,
    stderr: result.stderr?.trim() || null
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  let iteration = 0;
  for (;;) {
    iteration += 1;
    const cycleStartedAt = new Date().toISOString();
    const steps = [];
    steps.push(runNodeScript('seed', 'scripts/seed-market-agent-personas.mjs'));
    steps.push(runNodeScript('market_loop', 'scripts/run-agent-market-loop.mjs'));
    if (iteration % adversaryEvery === 0) {
      steps.push(runNodeScript('adversary_loop', 'scripts/run-agent-adversary-loop.mjs'));
    }
    const ok = steps.every(step => step.ok);
    const report = {
      kind: 'market_operator_worker_cycle',
      ok,
      iteration,
      base_url: baseUrl,
      cycle_started_at: cycleStartedAt,
      cycle_finished_at: new Date().toISOString(),
      next_run_at: runOnce ? null : new Date(Date.now() + intervalMs).toISOString(),
      steps
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (runOnce) process.exit(ok ? 0 : 1);
    await sleep(intervalMs);
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    kind: 'market_operator_worker_cycle',
    ok: false,
    fatal: true,
    message: String(error?.message ?? error),
    stack: error?.stack ?? null
  }));
  process.exit(1);
});
