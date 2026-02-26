#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const REQUIRED_GATES = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"];
const REQUIRED_PROGRESS_FILES = [
  "artifacts/progress/v2-task-tracker.json",
  "artifacts/progress/v2-gate-status.json",
  "artifacts/progress/v2-check-registry.json",
  "docs/reports/v2-daily-status.md"
];
const REQUIRED_RELEASE_FILES = [
  "artifacts/release/sc-rr-03-parity-signoff-report.json",
  "artifacts/release/final-gate-summary-report.json",
  "docs/reports/v2-release-notes.md",
  "artifacts/release/route-redirect-verification-report.json"
];
const CLOSED_STATUSES = new Set(["closed", "resolved", "done", "fixed"]);
const APPROVER_ROLES = ["ios-exec", "web-exec", "parity-integrator"];

function parseArgs(argv) {
  let writeStop = false;
  let releaseCandidate = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write-stop") {
      writeStop = true;
      continue;
    }

    if (arg === "--release-candidate") {
      releaseCandidate = argv[i + 1] ?? null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { writeStop, releaseCandidate };
}

function resolvePath(relPath) {
  return path.resolve(process.cwd(), relPath);
}

function exists(relPath) {
  return fs.existsSync(resolvePath(relPath));
}

function readJson(relPath, failures) {
  try {
    const raw = fs.readFileSync(resolvePath(relPath), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    failures.push({
      code: "INVALID_JSON",
      message: `Failed to parse JSON file: ${relPath}`,
      detail: String(error)
    });
    return null;
  }
}

function isOpenBlockingIssue(issue) {
  if (!issue || typeof issue !== "object") {
    return false;
  }

  const severity = String(issue.severity ?? "").toUpperCase();
  if (severity !== "P0" && severity !== "P1") {
    return false;
  }

  if (issue.resolved === true) {
    return false;
  }

  const status = String(issue.status ?? issue.state ?? "").toLowerCase();
  return !CLOSED_STATUSES.has(status);
}

function parseScopePolicies(taskTracker) {
  return Array.isArray(taskTracker?.scope_policies) ? taskTracker.scope_policies : [];
}

function isTaskGating(task, scopePolicies) {
  if (!task || typeof task !== "object") {
    return true;
  }

  if (typeof task.gating === "boolean") {
    return task.gating;
  }

  const taskId = String(task.task_id ?? "");
  for (const policy of scopePolicies) {
    const prefix = typeof policy?.task_prefix === "string" ? policy.task_prefix : null;
    const gating = typeof policy?.gating === "boolean" ? policy.gating : true;
    if (!prefix) {
      continue;
    }
    if (taskId.startsWith(prefix)) {
      return gating;
    }
  }

  return true;
}

function writeStopMarker(releaseCandidate) {
  const relPath = "artifacts/progress/v2-stop.json";
  const stopPayload = {
    stopped_at: new Date().toISOString(),
    reason: "All gates passed, all tasks done, parity and rollback verified",
    release_candidate: releaseCandidate,
    approved_by: APPROVER_ROLES
  };

  fs.mkdirSync(path.dirname(resolvePath(relPath)), { recursive: true });
  fs.writeFileSync(resolvePath(relPath), `${JSON.stringify(stopPayload, null, 2)}\n`, "utf8");
  return relPath;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    const output = {
      evaluated_at: new Date().toISOString(),
      pass: false,
      failures: [
        {
          code: "ARGUMENT_ERROR",
          message: String(error.message ?? error)
        }
      ]
    };
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 1;
    return;
  }

  const failures = [];
  const missingFiles = [];

  for (const relPath of [...REQUIRED_PROGRESS_FILES, ...REQUIRED_RELEASE_FILES]) {
    if (!exists(relPath)) {
      missingFiles.push(relPath);
    }
  }

  if (missingFiles.length > 0) {
    failures.push({
      code: "MISSING_REQUIRED_FILES",
      message: "One or more required progress/release files are missing.",
      detail: missingFiles
    });
  }

  const taskTracker = exists("artifacts/progress/v2-task-tracker.json")
    ? readJson("artifacts/progress/v2-task-tracker.json", failures)
    : null;
  const gateStatus = exists("artifacts/progress/v2-gate-status.json")
    ? readJson("artifacts/progress/v2-gate-status.json", failures)
    : null;
  if (exists("artifacts/progress/v2-check-registry.json")) {
    readJson("artifacts/progress/v2-check-registry.json", failures);
  }

  const tasks = Array.isArray(taskTracker?.tasks) ? taskTracker.tasks : [];
  const scopePolicies = parseScopePolicies(taskTracker);
  if (!Array.isArray(taskTracker?.tasks)) {
    failures.push({
      code: "INVALID_TASK_TRACKER",
      message: "Task tracker must contain an array at `tasks`."
    });
  }

  const gatingTasks = tasks.filter((task) => isTaskGating(task, scopePolicies));
  const nonGatingTasks = tasks.filter((task) => !isTaskGating(task, scopePolicies));

  if (gatingTasks.length === 0) {
    failures.push({
      code: "NO_TASKS_DEFINED",
      message: "Task tracker has no gating tasks; stop condition cannot be met."
    });
  }

  const nonDoneTasks = gatingTasks
    .filter((task) => String(task?.state ?? "") !== "done")
    .map((task, index) => ({
      task_id: task?.task_id ?? `task@${index + 1}`,
      state: String(task?.state ?? "unknown"),
      owner: task?.owner ?? null
    }));
  if (nonDoneTasks.length > 0) {
    failures.push({
      code: "TASKS_NOT_DONE",
      message: "Not all tasks are in `done` state.",
      detail: nonDoneTasks.map((t) => `${t.task_id}:${t.state}`)
    });
  }

  const openBlockers = [];
  gatingTasks.forEach((task, taskIndex) => {
    const issues = Array.isArray(task?.blocking_issues) ? task.blocking_issues : [];
    issues.forEach((issue, issueIndex) => {
      if (isOpenBlockingIssue(issue)) {
        openBlockers.push({
          task_id: task?.task_id ?? `task@${taskIndex + 1}`,
          issue_id: issue?.issue_id ?? `issue@${issueIndex + 1}`,
          severity: String(issue?.severity ?? "").toUpperCase(),
          summary: issue?.summary ?? null
        });
      }
    });
  });
  if (openBlockers.length > 0) {
    failures.push({
      code: "OPEN_BLOCKERS",
      message: "Open P0/P1 blocking issues were found.",
      detail: openBlockers.map((b) => `${b.task_id}:${b.issue_id}:${b.severity}`)
    });
  }

  const gates = Array.isArray(gateStatus?.gates) ? gateStatus.gates : [];
  if (!Array.isArray(gateStatus?.gates)) {
    failures.push({
      code: "INVALID_GATE_STATUS",
      message: "Gate status file must contain an array at `gates`."
    });
  }

  const gateMap = new Map(gates.map((gate) => [String(gate?.gate_id ?? ""), gate]));
  const missingGates = REQUIRED_GATES.filter((gateId) => !gateMap.has(gateId));
  if (missingGates.length > 0) {
    failures.push({
      code: "MISSING_GATES",
      message: "Required gates are missing from gate status.",
      detail: missingGates
    });
  }

  const nonPassGates = REQUIRED_GATES.filter((gateId) => {
    const status = String(gateMap.get(gateId)?.status ?? "");
    return status !== "PASS";
  }).map((gateId) => ({
    gate_id: gateId,
    status: String(gateMap.get(gateId)?.status ?? "missing")
  }));
  if (nonPassGates.length > 0) {
    failures.push({
      code: "GATES_NOT_PASS",
      message: "Not all required gates are PASS.",
      detail: nonPassGates.map((gate) => `${gate.gate_id}:${gate.status}`)
    });
  }

  const unresolvedFailingChecks = gates
    .filter((gate) => Array.isArray(gate?.failing_checks) && gate.failing_checks.length > 0)
    .flatMap((gate) =>
      gate.failing_checks.map((checkId) => ({
        gate_id: gate.gate_id,
        check_id: checkId
      }))
    );
  if (unresolvedFailingChecks.length > 0) {
    failures.push({
      code: "UNRESOLVED_FAILING_CHECKS",
      message: "Gate file includes unresolved failing checks.",
      detail: unresolvedFailingChecks.map((item) => `${item.gate_id}:${item.check_id}`)
    });
  }

  if (args.writeStop && !args.releaseCandidate) {
    failures.push({
      code: "MISSING_RELEASE_CANDIDATE",
      message: "Provide `--release-candidate <tag-or-sha>` when using `--write-stop`."
    });
  }

  let stopMarkerPath = null;
  const pass = failures.length === 0;
  if (pass && args.writeStop) {
    stopMarkerPath = writeStopMarker(args.releaseCandidate);
  }

  const output = {
    evaluated_at: new Date().toISOString(),
    pass,
    summary: {
      gates_total: REQUIRED_GATES.length,
      gates_pass: REQUIRED_GATES.length - nonPassGates.length,
      tasks_total: gatingTasks.length,
      tasks_done: gatingTasks.length - nonDoneTasks.length,
      tasks_non_gating: nonGatingTasks.length,
      open_blockers: openBlockers.length
    },
    failures,
    missing_files: missingFiles,
    non_done_tasks: nonDoneTasks,
    non_gating_tasks_pending: nonGatingTasks
      .filter((task) => String(task?.state ?? "") !== "done")
      .map((task, index) => ({
        task_id: task?.task_id ?? `non_gating@${index + 1}`,
        state: String(task?.state ?? "unknown"),
        owner: task?.owner ?? null
      })),
    open_blockers: openBlockers,
    stop_marker_written: Boolean(stopMarkerPath),
    stop_marker_path: stopMarkerPath
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = pass ? 0 : 1;
}

main();
