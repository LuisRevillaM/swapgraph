#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const milestonePath = process.argv[2];
if (!milestonePath) {
  console.error('Usage: node verify/runner.ts <milestone.yaml>');
  process.exit(1);
}

const raw = readFileSync(milestonePath, 'utf8');
const commands = [...raw.matchAll(/-\s*cmd:\s*"([^"]+)"/g)].map(m => m[1]);
const artifacts = [...raw.matchAll(/-\s*artifact:\s*"([^"]+)"/g)].map(m => m[1]);

const results = commands.map(cmd => {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { cmd, code: r.status ?? 1, ok: (r.status ?? 1) === 0 };
});
const art = artifacts.map(path => ({ path, ok: existsSync(path) }));
const overall = results.every(r => r.ok) && art.every(a => a.ok);

console.log(JSON.stringify({ milestone: milestonePath, commands: results, artifacts: art, overall }, null, 2));
process.exit(overall ? 0 : 2);
