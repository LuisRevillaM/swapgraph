import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcDir = path.join(root, 'src-ts', 'matching');
const outDir = path.join(root, 'src', 'matching-ts-shadow');
const checkOnly = process.argv.includes('--check');

mkdirSync(outDir, { recursive: true });

const files = readdirSync(srcDir)
  .filter(file => file.endsWith('.mts'))
  .sort((a, b) => a.localeCompare(b));

for (const file of files) {
  const srcPath = path.join(srcDir, file);
  const outPath = path.join(outDir, file.replace(/\.mts$/u, '.mjs'));
  const source = readFileSync(srcPath, 'utf8');
  const rewritten = source.replace(/(['"])([^'"\n]+?)\.mts\1/gu, '$1$2.mjs$1');
  const header = `// Generated from src-ts/matching/${file}. Do not edit directly.\n`;
  const expected = `${header}${rewritten}`;
  if (!checkOnly) {
    writeFileSync(outPath, expected, 'utf8');
    continue;
  }

  let actual = null;
  try {
    actual = readFileSync(outPath, 'utf8');
  } catch {
    actual = null;
  }

  if (actual !== expected) {
    console.error(`mismatch: ${outPath}`);
    process.exitCode = 1;
  }
}

const generated = files.map(file => file.replace(/\.mts$/u, '.mjs'));
if (checkOnly) {
  const existing = readdirSync(outDir)
    .filter(file => file.endsWith('.mjs'))
    .sort((a, b) => a.localeCompare(b));
  const expectedSet = new Set(generated);
  const extras = existing.filter(file => !expectedSet.has(file));
  if (extras.length > 0) {
    for (const extra of extras) {
      console.error(`extra: ${path.join(outDir, extra)}`);
    }
    process.exitCode = 1;
  }
}

console.log(JSON.stringify({
  ok: process.exitCode !== 1,
  check_only: checkOnly,
  source_dir: 'src-ts/matching',
  output_dir: 'src/matching-ts-shadow',
  files: generated
}, null, 2));
