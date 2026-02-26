#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const sourcePath = path.join(repoRoot, 'docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md');
const outPath = path.join(repoRoot, 'artifacts/web-m1/sc-g0-02-dag-report.json');

function parseAdjacency(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '## B. Dependency graph (adjacency list)');
  if (start === -1) throw new Error('dependency graph section missing');

  const edges = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('- WEB-T')) {
      if (line.startsWith('## ')) break;
      continue;
    }

    const match = /^-\s*(WEB-T\d+)\s*->\s*(.*)$/.exec(line);
    if (!match) continue;

    const from = match[1];
    const rawTargets = match[2];
    const targets = rawTargets.includes('(test harness dependency only)')
      ? []
      : rawTargets.split(',').map(item => item.trim()).filter(Boolean);

    edges.set(from, targets);
  }

  return edges;
}

function validateAcyclic(edges) {
  const inDegree = new Map();
  const adjacency = new Map();

  for (const [node, targets] of edges.entries()) {
    if (!inDegree.has(node)) inDegree.set(node, 0);
    adjacency.set(node, targets.slice());

    for (const target of targets) {
      if (!inDegree.has(target)) inDegree.set(target, 0);
      inDegree.set(target, inDegree.get(target) + 1);
    }
  }

  const queue = [];
  for (const [node, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(node);
  }

  const order = [];
  while (queue.length > 0) {
    const node = queue.shift();
    order.push(node);

    for (const target of adjacency.get(node) ?? []) {
      const nextDegree = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, nextDegree);
      if (nextDegree === 0) queue.push(target);
    }
  }

  const cycleNodes = [];
  for (const [node, degree] of inDegree.entries()) {
    if (degree > 0) cycleNodes.push(node);
  }

  return {
    acyclic: cycleNodes.length === 0,
    node_count: inDegree.size,
    edge_count: Array.from(adjacency.values()).reduce((sum, targets) => sum + targets.length, 0),
    topological_order: order,
    cycle_nodes: cycleNodes
  };
}

function main() {
  const markdown = readFileSync(sourcePath, 'utf8');
  const edges = parseAdjacency(markdown);
  const validation = validateAcyclic(edges);

  const output = {
    check_id: 'SC-G0-02',
    source: path.relative(repoRoot, sourcePath),
    generated_at: new Date().toISOString(),
    ...validation,
    pass: validation.acyclic
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
