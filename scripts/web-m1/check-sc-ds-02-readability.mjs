#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const tokenSourcePath = path.join(repoRoot, 'client/marketplace/tokens/design-tokens.json');
const stylesPath = path.join(repoRoot, 'client/marketplace/styles.css');
const outPath = path.join(repoRoot, 'artifacts/web-m1/sc-ds-02-readability-report.json');

function parseFloorPx(readabilityFloor) {
  const match = String(readabilityFloor ?? '').match(/([0-9]+(?:\.[0-9]+)?)px/);
  if (!match) throw new Error('cannot parse readability floor');
  return Number.parseFloat(match[1]);
}

function parseCssBlocks(text) {
  const blocks = [];
  const regex = /([^{}]+)\{([^{}]+)\}/g;
  for (const match of text.matchAll(regex)) {
    const selector = match[1].trim();
    const body = match[2].trim();
    blocks.push({ selector, body });
  }
  return blocks;
}

function extractDeclaration(body, property) {
  const pattern = new RegExp(`${property}\\s*:\\s*([^;]+);`);
  const match = pattern.exec(body);
  return match ? match[1].trim() : null;
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '').trim();
  if (![3, 6].includes(normalized.length)) throw new Error(`invalid hex color: ${hex}`);
  const expanded = normalized.length === 3
    ? normalized.split('').map(ch => `${ch}${ch}`).join('')
    : normalized;

  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  return { r, g, b };
}

function relativeLuminance(rgb) {
  const srgb = [rgb.r, rgb.g, rgb.b].map(channel => channel / 255);
  const linear = srgb.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foregroundHex, backgroundHex) {
  const l1 = relativeLuminance(hexToRgb(foregroundHex));
  const l2 = relativeLuminance(hexToRgb(backgroundHex));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function main() {
  const tokens = JSON.parse(readFileSync(tokenSourcePath, 'utf8'));
  const styles = readFileSync(stylesPath, 'utf8');

  const floorPx = parseFloorPx(tokens.typography?.['readability-floor']);
  const scale = tokens.typography?.scale ?? {};
  const blocks = parseCssBlocks(styles);

  const utilityChecks = [
    { selector: '.u-text-sm', expectedToken: 'sm' },
    { selector: '.u-text-base', expectedToken: 'base' },
    { selector: '.u-text-md', expectedToken: 'md' },
    { selector: '.u-text-lg', expectedToken: 'lg' },
    { selector: '.u-text-xl', expectedToken: 'xl' },
    { selector: '.u-text-data', expectedToken: 'data' },
    { selector: '.u-cap', expectedToken: 'sm' }
  ];

  const utilityFindings = utilityChecks.map(check => {
    const block = blocks.find(item => item.selector === check.selector);
    if (!block) {
      return {
        selector: check.selector,
        expected_token: check.expectedToken,
        pass: false,
        reason: 'missing_selector'
      };
    }

    const fontSizeValue = extractDeclaration(block.body, 'font-size');
    const expectedVariable = `var(--t-${check.expectedToken})`;
    const tokenPx = Number(scale?.[check.expectedToken]?.px ?? NaN);

    return {
      selector: check.selector,
      expected_token: check.expectedToken,
      font_size_value: fontSizeValue,
      token_px: tokenPx,
      pass: fontSizeValue === expectedVariable && tokenPx >= floorPx
    };
  });

  const disallowedXsUsage = blocks
    .filter(block => /font-size\s*:\s*var\(--t-xs\)/.test(block.body))
    .map(block => block.selector)
    .filter(selector => selector !== '.u-text-xs');

  const color = tokens.color ?? {};
  const contrastTargets = [
    { id: 'ink_on_canvas', fg: color.ink, bg: color.canvas },
    { id: 'ink_on_surface', fg: color.ink, bg: color.surface },
    { id: 'ink2_on_canvas', fg: color['ink-2'], bg: color.canvas },
    { id: 'ink2_on_surface', fg: color['ink-2'], bg: color.surface },
    { id: 'ink3_on_canvas', fg: color['ink-3'], bg: color.canvas },
    { id: 'ink3_on_surface', fg: color['ink-3'], bg: color.surface },
    { id: 'signal_text_on_signal_light', fg: color['signal-text'], bg: color['signal-light'] },
    { id: 'ink2_on_caution_light', fg: color['ink-2'], bg: color['caution-light'] },
    { id: 'danger_on_danger_light', fg: color.danger, bg: color['danger-light'] }
  ];

  const contrastFindings = contrastTargets.map(target => {
    const ratio = contrastRatio(target.fg, target.bg);
    return {
      id: target.id,
      ratio: Number(ratio.toFixed(2)),
      pass: ratio >= 4.5
    };
  });

  const output = {
    check_id: 'SC-DS-02',
    generated_at: new Date().toISOString(),
    sources: {
      token_source: path.relative(repoRoot, tokenSourcePath),
      styles: path.relative(repoRoot, stylesPath)
    },
    readability_floor_px: floorPx,
    utility_findings: utilityFindings,
    disallowed_t_xs_usage: disallowedXsUsage,
    contrast_findings: contrastFindings,
    pass: utilityFindings.every(item => item.pass)
      && disallowedXsUsage.length === 0
      && contrastFindings.every(item => item.pass)
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
