#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const stylesPath = path.join(repoRoot, 'client/marketplace/styles.css');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-ax-03-touch-target-baseline-report.json');

function parseCssBlocks(text) {
  const blocks = [];
  const regex = /([^{}]+)\{([^{}]+)\}/g;
  for (const match of text.matchAll(regex)) {
    blocks.push({
      selector: match[1].trim(),
      body: match[2].trim()
    });
  }
  return blocks;
}

function readDeclarationPx(body, property) {
  const match = new RegExp(`${property}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)px`).exec(body);
  return match ? Number.parseFloat(match[1]) : null;
}

function main() {
  const styles = readFileSync(stylesPath, 'utf8');
  const blocks = parseCssBlocks(styles);

  const targets = [
    { selector: '.skip-link', prop: 'min-height', minPx: 44 },
    { selector: '.refresh-btn', prop: 'min-height', minPx: 44 },
    { selector: '.refresh-btn', prop: 'min-width', minPx: 44 },
    { selector: '.tab-btn', prop: 'min-height', minPx: 44 },
    { selector: '.tab-btn', prop: 'min-width', minPx: 44 },
    { selector: '.demand-banner', prop: 'min-height', minPx: 44 },
    { selector: '.sort-btn', prop: 'min-height', minPx: 44 },
    { selector: '.inline-action', prop: 'min-height', minPx: 44 },
    { selector: '.btn-primary-inline', prop: 'min-height', minPx: 44 },
    { selector: '.btn-inline', prop: 'min-height', minPx: 44 },
    { selector: '.icon-btn', prop: 'width', minPx: 44 },
    { selector: '.icon-btn', prop: 'height', minPx: 44 },
    { selector: '.field-input', prop: 'min-height', minPx: 44 },
    { selector: '.choice-chip', prop: 'min-height', minPx: 44 }
  ];

  const rows = targets.map(target => {
    const block = blocks.find(item => item.selector === target.selector);
    const valuePx = block ? readDeclarationPx(block.body, target.prop) : null;
    return {
      selector: target.selector,
      property: target.prop,
      required_min_px: target.minPx,
      actual_px: valuePx,
      pass: Number.isFinite(valuePx) && valuePx >= target.minPx
    };
  });

  const output = {
    check_id: 'SC-AX-03',
    generated_at: new Date().toISOString(),
    source: path.relative(repoRoot, stylesPath),
    rows,
    pass: rows.every(row => row.pass)
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
