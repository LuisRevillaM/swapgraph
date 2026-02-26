#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const trackerPath = path.join(repoRoot, 'artifacts/progress/v2-task-tracker.json');

function parseArgs(argv) {
  const out = {
    taskId: null,
    state: null,
    checksFile: null,
    artifactsFile: null,
    blockerFile: null,
    clearBlockers: false,
    promoteReadyPlatform: null,
    owner: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--task' && next) {
      out.taskId = next;
      i += 1;
      continue;
    }
    if (token === '--state' && next) {
      out.state = next;
      i += 1;
      continue;
    }
    if (token === '--checks-file' && next) {
      out.checksFile = next;
      i += 1;
      continue;
    }
    if (token === '--artifacts-file' && next) {
      out.artifactsFile = next;
      i += 1;
      continue;
    }
    if (token === '--blocker-file' && next) {
      out.blockerFile = next;
      i += 1;
      continue;
    }
    if (token === '--promote-ready-platform' && next) {
      out.promoteReadyPlatform = next;
      i += 1;
      continue;
    }
    if (token === '--owner' && next) {
      out.owner = next;
      i += 1;
      continue;
    }
    if (token === '--clear-blockers') {
      out.clearBlockers = true;
      continue;
    }

    throw new Error(`Unknown or malformed argument: ${token}`);
  }

  return out;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function maybeReadJson(filePath) {
  if (!filePath) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return value;
}

function updateTaskTimestamps(task, state, now) {
  const perStateField = {
    ready: 'ready_at',
    in_progress: 'started_at',
    implemented: 'implemented_at',
    verified: 'verified_at',
    accepted: 'accepted_at',
    done: 'done_at'
  };

  if (state && perStateField[state]) {
    const field = perStateField[state];
    task[field] = now;
  }
}

function promoteReadyTasks(data, platform, now) {
  if (!platform) return [];
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  const promoted = [];

  for (const task of tasks) {
    if (String(task?.platform ?? '') !== platform) continue;
    if (String(task?.state ?? '') !== 'planned') continue;

    const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
    const depsDone = deps.every(depId => String(byId.get(depId)?.state ?? '') === 'done');

    if (depsDone) {
      task.state = 'ready';
      task.last_updated_at = now;
      updateTaskTimestamps(task, 'ready', now);
      promoted.push(task.task_id);
    }
  }

  return promoted;
}

function main() {
  const args = parseArgs(process.argv);
  const now = new Date().toISOString();

  const data = readJson(trackerPath);
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];

  const checksValue = maybeReadJson(args.checksFile);
  const artifactsValue = maybeReadJson(args.artifactsFile);
  const blockerValue = maybeReadJson(args.blockerFile);

  if (args.taskId) {
    const task = tasks.find(row => row.task_id === args.taskId);
    if (!task) {
      throw new Error(`Task not found: ${args.taskId}`);
    }

    if (args.owner) {
      task.owner = args.owner;
    }

    if (args.state) {
      task.state = args.state;
      updateTaskTimestamps(task, args.state, now);
    }

    if (checksValue !== null) {
      task.checks_passed = ensureArray(checksValue, 'checks');
    }

    if (artifactsValue !== null) {
      task.artifacts = ensureArray(artifactsValue, 'artifacts');
    }

    if (args.clearBlockers) {
      task.blocking_issues = [];
    }

    if (blockerValue !== null) {
      if (!task.blocking_issues || !Array.isArray(task.blocking_issues)) {
        task.blocking_issues = [];
      }
      task.blocking_issues.push(blockerValue);
    }

    task.last_updated_at = now;
  }

  const promoted = promoteReadyTasks(data, args.promoteReadyPlatform, now);

  data.generated_at = now;
  writeFileSync(trackerPath, `${JSON.stringify(data, null, 2)}\n`);

  const result = {
    ok: true,
    updated_task: args.taskId,
    state: args.state,
    promoted
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
