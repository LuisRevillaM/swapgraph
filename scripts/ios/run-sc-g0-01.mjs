#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function hasValidIso8601(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function validateTrackerShape() {
  const tracker = readJson('artifacts/progress/v2-task-tracker.json');
  const tasks = Array.isArray(tracker.tasks) ? tracker.tasks : [];
  const allowedStates = new Set(Array.isArray(tracker.allowed_states) ? tracker.allowed_states : [
    'planned',
    'ready',
    'in_progress',
    'implemented',
    'verified',
    'accepted',
    'done'
  ]);

  const taskIds = new Set(tasks.map((task) => task?.task_id).filter(Boolean));
  const iosTasks = tasks.filter((task) => String(task?.platform ?? '') === 'ios');
  const requiredFields = [
    'task_id',
    'title',
    'platform',
    'track',
    'owner',
    'verification_owner',
    'gating',
    'state',
    'priority',
    'depends_on',
    'checks_required',
    'checks_passed',
    'blocking_issues',
    'artifacts',
    'last_updated_at'
  ];

  const issues = [];

  for (const task of iosTasks) {
    const taskId = String(task?.task_id ?? 'unknown');

    for (const field of requiredFields) {
      if (!(field in task)) {
        issues.push({ task_id: taskId, type: 'missing_field', field });
      }
    }

    if (!/^IOS-T\d{3}$/.test(taskId) && !/^ST-IOS-T\d{3}$/.test(taskId)) {
      issues.push({ task_id: taskId, type: 'invalid_task_id' });
    }

    if (!allowedStates.has(String(task?.state ?? ''))) {
      issues.push({ task_id: taskId, type: 'invalid_state', state: task?.state ?? null });
    }

    if (!Array.isArray(task?.depends_on)) {
      issues.push({ task_id: taskId, type: 'invalid_depends_on' });
    } else {
      for (const dep of task.depends_on) {
        if (!taskIds.has(dep)) {
          issues.push({ task_id: taskId, type: 'unknown_dependency', dependency: dep });
        }
      }
    }

    if (!Array.isArray(task?.checks_required)) {
      issues.push({ task_id: taskId, type: 'invalid_checks_required' });
    }

    if (!Array.isArray(task?.checks_passed)) {
      issues.push({ task_id: taskId, type: 'invalid_checks_passed' });
    }

    if (!Array.isArray(task?.blocking_issues)) {
      issues.push({ task_id: taskId, type: 'invalid_blocking_issues' });
    }

    if (!Array.isArray(task?.artifacts)) {
      issues.push({ task_id: taskId, type: 'invalid_artifacts' });
    }

    if (!hasValidIso8601(task?.last_updated_at)) {
      issues.push({ task_id: taskId, type: 'invalid_last_updated_at', value: task?.last_updated_at ?? null });
    }
  }

  return {
    ios_task_count: iosTasks.length,
    issues
  };
}

function validateAppShellRoutingContract() {
  const tabSource = readText('ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/MarketplaceTab.swift');
  const routeSource = readText('ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppRoute.swift');
  const viewSource = readText('ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift');

  const expectedTabs = ['items', 'intents', 'inbox', 'active', 'receipts'];
  const missingTabs = expectedTabs.filter((tab) => !new RegExp(`case\\s+${tab}\\b`).test(tabSource));

  const routeContractChecks = [
    { id: 'route_tab', pass: /case\s+tab\(MarketplaceTab\)/.test(routeSource) },
    { id: 'route_proposal', pass: /case\s+proposal\(id:\s*String\)/.test(routeSource) },
    { id: 'route_active', pass: /case\s+activeSwap\(cycleID:\s*String\)/.test(routeSource) },
    { id: 'route_receipt', pass: /case\s+receipt\(cycleID:\s*String\)/.test(routeSource) }
  ];

  const shellChecks = [
    { id: 'tabview_binding', pass: /TabView\(selection:\s*\$viewModel\.selectedTab\)/.test(viewSource) },
    { id: 'tab_iteration', pass: /ForEach\(viewModel\.availableTabs\)/.test(viewSource) },
    { id: 'a11y_tab_identifier', pass: viewSource.includes('accessibilityIdentifier("tab.\\(tab.rawValue)")') }
  ];

  const checks = [
    ...routeContractChecks,
    ...shellChecks,
    { id: 'five_tab_enum', pass: missingTabs.length === 0 }
  ];

  return {
    checks,
    missing_tabs: missingTabs
  };
}

function main() {
  const trackerValidation = validateTrackerShape();
  const shellValidation = validateAppShellRoutingContract();

  const failingShellChecks = shellValidation.checks.filter((row) => !row.pass);
  const overall = trackerValidation.issues.length === 0 && failingShellChecks.length === 0;

  const report = {
    check_id: 'SC-G0-01',
    overall,
    tracker: {
      ios_task_count: trackerValidation.ios_task_count,
      issue_count: trackerValidation.issues.length,
      issues: trackerValidation.issues
    },
    app_shell_contract: {
      checks: shellValidation.checks,
      missing_tabs: shellValidation.missing_tabs
    }
  };

  if (!overall) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
