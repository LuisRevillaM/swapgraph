import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M92';
const SCENARIO_FILE = 'fixtures/release/m92_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m92_expected.json';
const OUTPUT_FILE = 'release_readiness_conformance_output.json';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readUtf8(relPath) {
  return readFileSync(path.join(root, relPath), 'utf8');
}

function checkContainsTokens({ text, tokens }) {
  const missing = [];
  for (const token of tokens ?? []) {
    if (!text.includes(token)) missing.push(token);
  }
  return missing;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

const requiredFiles = scenario.required_files ?? [];
const requiredFileChecks = requiredFiles.map(relPath => ({
  path: relPath,
  exists: existsSync(path.join(root, relPath))
}));
const missingFiles = requiredFileChecks.filter(x => !x.exists).map(x => x.path);

const milestones = Array.isArray(scenario.milestones) ? scenario.milestones : [];
const milestoneChecks = [];
const missingMilestoneDescriptors = [];
const missingMilestoneEvidence = [];

for (const num of milestones) {
  const m = Number(num);
  const label = `M${m}`;

  const descriptorPaths = [
    `docs/prd/${label}.md`,
    `milestones/${label}.yaml`,
    `verify/m${m}.sh`
  ];

  const descriptorMissing = descriptorPaths.filter(rel => !existsSync(path.join(root, rel)));
  if (descriptorMissing.length > 0) {
    missingMilestoneDescriptors.push({ milestone: label, missing: descriptorMissing });
  }

  const evidencePath = `artifacts/milestones/${label}/latest/commands.log`;
  const evidenceRequired = m <= 91;
  const evidenceExists = !evidenceRequired || existsSync(path.join(root, evidencePath));

  if (!evidenceExists) {
    missingMilestoneEvidence.push({ milestone: label, missing: [evidencePath] });
  }

  milestoneChecks.push({
    milestone: label,
    descriptor_paths: descriptorPaths,
    descriptor_missing: descriptorMissing,
    evidence_required: evidenceRequired,
    evidence_path: evidencePath,
    evidence_exists: evidenceExists,
    ok: descriptorMissing.length === 0 && evidenceExists
  });
}

const conformanceText = existsSync(path.join(root, 'docs/spec/CONFORMANCE.md'))
  ? readUtf8('docs/spec/CONFORMANCE.md')
  : '';
const statusText = existsSync(path.join(root, 'docs/STATUS.md'))
  ? readUtf8('docs/STATUS.md')
  : '';
const gapsText = existsSync(path.join(root, 'docs/spec/GAPS.md'))
  ? readUtf8('docs/spec/GAPS.md')
  : '';
const blockersText = existsSync(path.join(root, 'BLOCKERS.md'))
  ? readUtf8('BLOCKERS.md')
  : '';

const missingConformanceTokens = checkContainsTokens({ text: conformanceText, tokens: scenario.required_conformance_tokens });
const missingStatusTokens = checkContainsTokens({ text: statusText, tokens: scenario.required_status_tokens });
const missingGapsTokens = checkContainsTokens({ text: gapsText, tokens: scenario.required_gaps_tokens });
const missingBlockersTokens = checkContainsTokens({ text: blockersText, tokens: scenario.required_blockers_tokens });

const summary = {
  milestones_total: milestoneChecks.length,
  milestones_ok: milestoneChecks.filter(x => x.ok).length,
  required_files_total: requiredFileChecks.length,
  required_files_ok: requiredFileChecks.filter(x => x.exists).length,
  missing_files_count: missingFiles.length,
  missing_milestone_descriptors_count: missingMilestoneDescriptors.length,
  missing_milestone_evidence_count: missingMilestoneEvidence.length,
  missing_conformance_tokens_count: missingConformanceTokens.length,
  missing_status_tokens_count: missingStatusTokens.length,
  missing_gaps_tokens_count: missingGapsTokens.length,
  missing_blockers_tokens_count: missingBlockersTokens.length
};

summary.release_ready = summary.milestones_ok === summary.milestones_total
  && summary.required_files_ok === summary.required_files_total
  && summary.missing_files_count === 0
  && summary.missing_milestone_descriptors_count === 0
  && summary.missing_milestone_evidence_count === 0
  && summary.missing_conformance_tokens_count === 0
  && summary.missing_status_tokens_count === 0
  && summary.missing_gaps_tokens_count === 0
  && summary.missing_blockers_tokens_count === 0;

const out = canonicalize({
  summary,
  required_file_checks: requiredFileChecks,
  milestone_checks: milestoneChecks,
  missing_files: missingFiles,
  missing_milestone_descriptors: missingMilestoneDescriptors,
  missing_milestone_evidence: missingMilestoneEvidence,
  missing_tokens: {
    conformance: missingConformanceTokens,
    status: missingStatusTokens,
    gaps: missingGapsTokens,
    blockers: missingBlockersTokens
  }
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = createHash('sha256').update(JSON.stringify(out), 'utf8').digest('hex');
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { milestones_checked: milestoneChecks.length } }, null, 2));
