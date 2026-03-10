#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkFile(relPath) {
  return existsSync(path.join(root, relPath));
}

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(path.join(root, relPath), 'utf8'));
  } catch {
    return null;
  }
}

function readTaskYaml(relPath) {
  try {
    const raw = readFileSync(path.join(root, relPath), 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^([a-z_]+):\s*(.+)?$/i);
      if (!match) continue;
      out[match[1]] = (match[2] ?? '').trim().replace(/^"|"$/g, '');
    }
    return out;
  } catch {
    return null;
  }
}

function taskDone(taskPath) {
  const task = readTaskYaml(taskPath);
  return !!task && task.status === 'done' && task.commit && task.commit !== 'PENDING';
}

function marketLoopVerified() {
  const artifact = readJson('docs/evidence/market-vnext/agent-market-loop.latest.json');
  return !!artifact
    && artifact.ok === true
    && !!artifact.direct?.receipt_id
    && !!artifact.mixed?.receipt_id
    && !!artifact.cycle?.receipt_id;
}

function adversaryLoopVerified() {
  const artifact = readJson('docs/evidence/market-vnext/agent-adversary-loop.latest.json');
  return !!artifact
    && artifact.ok === true
    && artifact.replay_same_plan_id === true
    && artifact.outsider_accept_status === 403
    && artifact.outsider_complete_status === 403
    && (artifact.duplicate_failure_status === 400 || artifact.duplicate_failure_status === 409)
    && artifact.final_plan_status === 'unwound'
    && artifact.final_receipt_state === 'unwound';
}

function planManifestConsistent() {
  const manifest = readJson('work/market-vnext/plan.json');
  if (!manifest) return false;
  return manifest.plan_doc === 'docs/plans/market-vnext-agent-execution.md'
    && Array.isArray(manifest.finish_gate_command)
    && manifest.finish_gate_command.join(' ') === 'node scripts/run-market-vnext-finish-gate.mjs'
    && Array.isArray(manifest.dispatch_command)
    && manifest.dispatch_command.join(' ') === 'node scripts/run-market-vnext-agent-dispatch.mjs';
}

const conditions = {
  market_public_surface_documented: checkFile('docs/plans/market-vnext-agent-execution.md'),
  task_queue_present: checkFile('work/market-vnext/tasks/M170-001.yaml'),
  plan_manifest_present: checkFile('work/market-vnext/plan.json'),
  plan_manifest_consistent: planManifestConsistent(),
  plan_dispatch_present: checkFile('scripts/run-market-vnext-agent-dispatch.mjs'),
  blueprint_market_present: checkFile('src/service/marketBlueprintService.mjs'),
  candidate_market_present: checkFile('src/service/marketCandidateService.mjs'),
  execution_plan_market_present: checkFile('src/service/marketExecutionPlanService.mjs'),
  targeted_candidate_tests_present: checkFile('tests/market/market-blueprints-candidates.test.mjs'),
  targeted_plan_tests_present: checkFile('tests/market/market-execution-plans.test.mjs'),
  cli_present: checkFile('scripts/market-cli.mjs'),
  finish_gate_present: true,
  agent_bootstrap_present: checkFile('scripts/bootstrap-market-vnext-agent-dev.sh'),
  agent_market_loop_present: checkFile('scripts/run-agent-market-loop.mjs'),
  agent_market_loop_verified: marketLoopVerified(),
  agent_adversary_loop_present: checkFile('scripts/run-agent-adversary-loop.mjs'),
  agent_adversary_loop_verified: adversaryLoopVerified(),
  obligation_graph_design_present: checkFile('docs/design/market-obligation-graph.md'),
  role_model_design_present: checkFile('docs/design/market-role-model.md'),
  failure_semantics_design_present: checkFile('docs/design/market-failure-semantics.md'),
  trust_artifacts_design_present: checkFile('docs/design/market-trust-artifacts.md'),
  clearing_policy_design_present: checkFile('docs/design/market-clearing-policy.md'),
  mechanism_tasks_recorded: taskDone('work/market-vnext/tasks/M170-001.yaml')
    && taskDone('work/market-vnext/tasks/M170-002.yaml')
    && taskDone('work/market-vnext/tasks/M171-001.yaml')
    && taskDone('work/market-vnext/tasks/M173-001.yaml'),
  agent_dogfood_task_recorded: taskDone('work/market-vnext/tasks/M174-001.yaml')
};

const unmet = Object.entries(conditions)
  .filter(([, ok]) => !ok)
  .map(([key]) => key);

const recommendedNextTasks = [
  !conditions.obligation_graph_design_present ? 'M170-001' : null,
  !conditions.failure_semantics_design_present ? 'M170-002' : null,
  !conditions.agent_bootstrap_present ? 'M174-001' : null,
  !conditions.agent_market_loop_verified ? 'M174-001' : null,
  !conditions.agent_adversary_loop_verified ? 'M174-001' : null,
  !conditions.clearing_policy_design_present ? 'M172-001' : null,
  !conditions.role_model_design_present ? 'M170-001' : null,
  !conditions.plan_manifest_consistent ? 'M174-002' : null,
  !conditions.mechanism_tasks_recorded ? 'M174-002' : null
].filter(Boolean);

const body = {
  plan_id: 'market-vnext-agent-execution',
  complete: unmet.length === 0,
  conditions,
  unmet,
  recommended_next_tasks: Array.from(new Set(recommendedNextTasks)),
  checked_at: new Date().toISOString()
};

process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
process.exit(body.complete ? 0 : 1);
