#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const sourcePath = path.join(repoRoot, 'docs/prd/2026-02-24_marketplace-web-phase0-task-pack.md');
const outPath = path.join(repoRoot, 'artifacts/web-m0/sc-g0-01-task-schema-completeness-report.json');

const REQUIRED_COLUMNS = [
  'Order',
  'Task ID',
  'Epic',
  'User-visible outcome',
  'Implementation notes',
  'Dependencies',
  'Risks',
  'Verification mapping',
  'Definition of done',
  'Size'
];

function splitCells(row) {
  return row
    .split('|')
    .slice(1, -1)
    .map(cell => cell.trim());
}

function parseTaskMatrix(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === '## A. Dependency-ordered task matrix (schema-complete)');
  if (start === -1) throw new Error('task matrix section missing');

  const tableLines = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('## ')) break;
    if (line.trim().startsWith('|')) tableLines.push(line.trim());
  }

  if (tableLines.length < 3) throw new Error('task matrix table is missing or malformed');

  const headers = splitCells(tableLines[0]);
  const rows = tableLines.slice(2).map(splitCells);
  return { headers, rows };
}

function parseDependencies(value) {
  if (!value || value.toLowerCase() === 'none') return [];
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseChecks(value) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function lintRows(headers, rows) {
  const issues = [];
  const headerSet = new Set(headers);
  const missingColumns = REQUIRED_COLUMNS.filter(column => !headerSet.has(column));

  if (missingColumns.length > 0) {
    issues.push({
      id: 'missing_required_columns',
      message: `Missing required columns: ${missingColumns.join(', ')}`,
      pass: false
    });
  }

  const orderIndex = headers.indexOf('Order');
  const taskIdIndex = headers.indexOf('Task ID');
  const dependenciesIndex = headers.indexOf('Dependencies');
  const checksIndex = headers.indexOf('Verification mapping');
  const sizeIndex = headers.indexOf('Size');

  const seenOrder = new Set();
  const seenTaskId = new Set();
  const expectedTaskIds = new Set(Array.from({ length: 32 }, (_, index) => `WEB-T${String(index + 1).padStart(3, '0')}`));

  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const rowRecord = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));

    for (const column of REQUIRED_COLUMNS) {
      const value = rowRecord[column] ?? '';
      if (!String(value).trim()) {
        issues.push({
          id: 'empty_required_field',
          row: rowNumber,
          field: column,
          message: `Row ${rowNumber} has empty value for "${column}"`,
          pass: false
        });
      }
    }

    const orderRaw = row[orderIndex] ?? '';
    const order = Number(orderRaw);
    if (!Number.isInteger(order) || order < 1) {
      issues.push({
        id: 'invalid_order',
        row: rowNumber,
        value: orderRaw,
        message: `Row ${rowNumber} has invalid order value "${orderRaw}"`,
        pass: false
      });
    } else if (seenOrder.has(order)) {
      issues.push({
        id: 'duplicate_order',
        row: rowNumber,
        value: order,
        message: `Order ${order} is duplicated`,
        pass: false
      });
    } else {
      seenOrder.add(order);
    }

    const taskId = row[taskIdIndex] ?? '';
    if (!/^WEB-T\d{3}$/.test(taskId)) {
      issues.push({
        id: 'invalid_task_id',
        row: rowNumber,
        value: taskId,
        message: `Row ${rowNumber} has invalid Task ID "${taskId}"`,
        pass: false
      });
    } else if (seenTaskId.has(taskId)) {
      issues.push({
        id: 'duplicate_task_id',
        row: rowNumber,
        value: taskId,
        message: `Task ID ${taskId} is duplicated`,
        pass: false
      });
    } else {
      seenTaskId.add(taskId);
    }

    const dependencies = parseDependencies(row[dependenciesIndex] ?? '');
    const invalidDependencies = dependencies.filter(item => !/^WEB-T\d{3}$/.test(item));
    if (invalidDependencies.length > 0) {
      issues.push({
        id: 'invalid_dependency_id',
        row: rowNumber,
        value: invalidDependencies,
        message: `Row ${rowNumber} has invalid dependency IDs`,
        pass: false
      });
    }

    const checks = parseChecks(row[checksIndex] ?? '');
    const invalidChecks = checks.filter(item => !/^SC-[A-Z0-9-]+$/.test(item));
    if (invalidChecks.length > 0) {
      issues.push({
        id: 'invalid_check_id',
        row: rowNumber,
        value: invalidChecks,
        message: `Row ${rowNumber} has invalid check IDs`,
        pass: false
      });
    }

    const size = (row[sizeIndex] ?? '').trim();
    if (!['S', 'M', 'L', 'XL'].includes(size)) {
      issues.push({
        id: 'invalid_size',
        row: rowNumber,
        value: size,
        message: `Row ${rowNumber} has invalid size "${size}"`,
        pass: false
      });
    }
  });

  const missingTaskIds = [...expectedTaskIds].filter(taskId => !seenTaskId.has(taskId));
  if (missingTaskIds.length > 0) {
    issues.push({
      id: 'missing_task_ids',
      message: 'Task matrix is missing expected task IDs',
      value: missingTaskIds,
      pass: false
    });
  }

  return {
    issues,
    row_count: rows.length,
    expected_task_count: expectedTaskIds.size
  };
}

function main() {
  const markdown = readFileSync(sourcePath, 'utf8');
  const { headers, rows } = parseTaskMatrix(markdown);
  const lint = lintRows(headers, rows);

  const output = {
    check_id: 'SC-G0-01',
    generated_at: new Date().toISOString(),
    source: path.relative(repoRoot, sourcePath),
    required_columns: REQUIRED_COLUMNS,
    headers,
    row_count: lint.row_count,
    expected_task_count: lint.expected_task_count,
    issues: lint.issues,
    pass: lint.issues.length === 0
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
