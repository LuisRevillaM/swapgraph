#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const taskPackPath = path.join(repoRoot, 'docs/prd/2026-02-24_marketplace-ios-phase0-task-pack.md');

const markdown = readFileSync(taskPackPath, 'utf8');

const taskIds = new Set();
for (const line of markdown.split('\n')) {
  const m = line.match(/^\|\s*\d+\s*\|\s*(IOS-T\d{3})\s*\|/);
  if (m) {
    taskIds.add(m[1]);
  }
}

const edgePattern = /^-\s*(IOS-T\d{3})\s*->\s*(.+)$/;
const edges = [];
const adjacency = new Map();

for (const line of markdown.split('\n')) {
  const m = line.match(edgePattern);
  if (!m) continue;

  const from = m[1];
  const rhs = m[2].trim();
  const targets = rhs === '(test harness dependency only)' || rhs === 'none'
    ? []
    : rhs
      .split(',')
      .map(token => token.trim())
      .filter(token => /^IOS-T\d{3}$/.test(token));

  adjacency.set(from, targets);
  for (const to of targets) {
    edges.push([from, to]);
  }
}

for (const taskId of taskIds) {
  if (!adjacency.has(taskId)) {
    adjacency.set(taskId, []);
  }
}

const missingNodes = edges.filter(([, to]) => !taskIds.has(to)).map(([from, to]) => ({ from, to }));

const visitState = new Map();
const cyclePath = [];
let cycleFound = null;

function dfs(node, trail) {
  if (cycleFound) return;

  const state = visitState.get(node) ?? 0;
  if (state === 1) {
    const start = trail.indexOf(node);
    cycleFound = trail.slice(start).concat(node);
    return;
  }
  if (state === 2) return;

  visitState.set(node, 1);
  const nextTrail = trail.concat(node);
  for (const next of adjacency.get(node) ?? []) {
    dfs(next, nextTrail);
    if (cycleFound) return;
  }
  visitState.set(node, 2);
}

for (const node of adjacency.keys()) {
  dfs(node, []);
  if (cycleFound) break;
}

const indegree = new Map(Array.from(adjacency.keys(), key => [key, 0]));
for (const [, to] of edges) {
  indegree.set(to, (indegree.get(to) ?? 0) + 1);
}

const queue = Array.from(indegree.entries())
  .filter(([, degree]) => degree === 0)
  .map(([node]) => node)
  .sort();

const topoOrder = [];
while (queue.length > 0) {
  const node = queue.shift();
  topoOrder.push(node);
  for (const next of adjacency.get(node) ?? []) {
    indegree.set(next, (indegree.get(next) ?? 0) - 1);
    if ((indegree.get(next) ?? 0) === 0) {
      queue.push(next);
      queue.sort();
    }
  }
}

const overall = missingNodes.length === 0 && cycleFound === null && topoOrder.length === adjacency.size;

const report = {
  check_id: 'SC-G0-02',
  overall,
  task_count: taskIds.size,
  edge_count: edges.length,
  cycle_detected: cycleFound !== null,
  cycle_path: cycleFound,
  missing_dependency_nodes: missingNodes,
  topological_order_count: topoOrder.length,
  topological_order_preview: topoOrder.slice(0, 12)
};

if (!overall) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(report, null, 2));
