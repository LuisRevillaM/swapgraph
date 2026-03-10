#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = path.join(root, 'work/market-vnext/plan.json');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '[]') return [];
  if (value === 'true') return true;
  if (value === 'false') return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseTaskYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const task = {};
  let currentKey = null;
  let currentMode = null;
  let blockIndent = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    if (currentMode === 'block') {
      if (indent > blockIndent) {
        task[currentKey].push(line.slice(blockIndent + 2).trimEnd());
        continue;
      }
      task[currentKey] = task[currentKey].join(' ').trim();
      currentMode = null;
      currentKey = null;
    }

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentMode === 'list' && currentKey) {
      task[currentKey].push(parseScalar(listMatch[1]));
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, rawValue] = keyMatch;

    if (rawValue === '>') {
      currentKey = key;
      currentMode = 'block';
      blockIndent = indent;
      task[key] = [];
      continue;
    }

    if (rawValue === '') {
      currentKey = key;
      currentMode = 'list';
      task[key] = [];
      continue;
    }

    currentKey = null;
    currentMode = null;
    task[key] = parseScalar(rawValue);
  }

  if (currentMode === 'block' && currentKey) {
    task[currentKey] = task[currentKey].join(' ').trim();
  }

  for (const key of ['depends_on', 'files_expected', 'acceptance_criteria', 'verification']) {
    if (!Array.isArray(task[key])) task[key] = task[key] ? [task[key]] : [];
  }
  return task;
}

function loadTasks(taskDir) {
  const entries = readdirSync(taskDir).filter(name => name.endsWith('.yaml')).sort();
  return entries.map(name => {
    const filePath = path.join(taskDir, name);
    const task = parseTaskYaml(readFileSync(filePath, 'utf8'));
    task.file = path.relative(root, filePath);
    return task;
  });
}

function priorityRank(priority, order) {
  const idx = order.indexOf(priority);
  return idx >= 0 ? idx : order.length;
}

function finishGate(plan) {
  const [cmd, ...args] = plan.finish_gate_command;
  try {
    const output = execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
    return { ok: true, result: JSON.parse(output) };
  } catch (error) {
    const stdout = String(error.stdout ?? '').trim();
    if (stdout) {
      try {
        return { ok: false, result: JSON.parse(stdout) };
      } catch {
        return { ok: false, result: { complete: false, parse_error: true, raw: stdout } };
      }
    }
    return { ok: false, result: { complete: false, exec_error: String(error.message ?? error) } };
  }
}

function chooseNextTask(tasks, plan) {
  const done = new Set(tasks.filter(task => task.status === 'done').map(task => task.id));
  const ready = tasks.filter(task => {
    if (task.status !== 'ready' && task.status !== 'todo') return false;
    return task.depends_on.every(dep => done.has(dep));
  });
  ready.sort((a, b) => {
    const pa = priorityRank(a.priority, plan.priority_order);
    const pb = priorityRank(b.priority, plan.priority_order);
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
  return ready[0] ?? null;
}

if (!existsSync(planPath)) {
  process.stderr.write(JSON.stringify({ ok: false, message: 'plan manifest missing', path: path.relative(root, planPath) }, null, 2) + '\n');
  process.exit(2);
}

const plan = readJson(planPath);
const taskDir = path.join(root, plan.task_dir);
const tasks = loadTasks(taskDir);
const gate = finishGate(plan);
const nextTask = gate.result?.complete ? null : chooseNextTask(tasks, plan);
const blockedTasks = tasks.filter(task => task.status === 'blocked').map(task => ({ id: task.id, title: task.title, file: task.file }));
const waitingTasks = tasks.filter(task => (task.status === 'ready' || task.status === 'todo') && !task.depends_on.every(dep => tasks.some(t => t.id === dep && t.status === 'done'))).map(task => ({ id: task.id, depends_on: task.depends_on, file: task.file }));

const body = {
  plan_id: plan.plan_id,
  complete: !!gate.result?.complete,
  finish_gate: gate.result,
  next_task: nextTask ? {
    id: nextTask.id,
    title: nextTask.title,
    summary: nextTask.summary,
    file: nextTask.file,
    priority: nextTask.priority,
    depends_on: nextTask.depends_on,
    files_expected: nextTask.files_expected,
    acceptance_criteria: nextTask.acceptance_criteria,
    verification: nextTask.verification,
    commit_message: nextTask.commit_message,
    evidence_file: nextTask.evidence_file
  } : null,
  blocked_tasks: blockedTasks,
  waiting_tasks: waitingTasks,
  done_tasks: tasks.filter(task => task.status === 'done').map(task => task.id),
  instruction: gate.result?.complete
    ? `Stop. Finish gate passed.`
    : nextTask
      ? `Execute ${nextTask.id}. When done, commit with the required message, update the task file, then rerun ${plan.dispatch_command.join(' ')}.`
      : blockedTasks.length > 0
        ? `Stop. One or more tasks are blocked and no further ready task is available.`
        : `No ready task found. Inspect dependencies or task statuses.`
};

process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
if (body.complete) process.exit(0);
if (nextTask) process.exit(0);
if (blockedTasks.length > 0) process.exit(2);
process.exit(1);
