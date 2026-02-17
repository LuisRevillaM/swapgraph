import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

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

// ---- Load API manifest for response schema mapping ----
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

// ---- Load schemas into AJV ----
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

// ---- Load scenario + expected ----
const scenarioPath = path.join(root, 'fixtures/proposals/m18_scenario.json');
const expectedPath = path.join(root, 'fixtures/proposals/m18_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const actorRefs = {
  actor_agent: scenario.actor_agent,
  actor_partner: scenario.actor_partner,
  actor_partner_other: scenario.actor_partner_other,
  actor_user_outsider: scenario.actor_user_outsider,
  actor_user_u1: scenario.actor_user_u1,
  actor_user_u5: scenario.actor_user_u5
};

// ---- Seed store proposals from matching fixture output ----
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const p3 = proposals.find(p => (p.participants ?? []).length === 3);
const p2 = proposals.find(p => (p.participants ?? []).length === 2);
if (!p3 || !p2) throw new Error('expected both a 3-cycle and 2-cycle proposal in fixtures');

const proposalByRef = { p2, p3 };

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

// Model partner scoping for multi-tenant reads.
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
for (const p of proposals) {
  store.state.tenancy.proposals[p.id] = { partner_id: scenario.actor_partner.id };
}

const readSvc = new CycleProposalsReadService({ store });

const operations = [];

for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.list') {
    const actor = actorRefs[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const r = readSvc.list({ actor });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);

      const ids = (r.body.proposals ?? []).map(p => p.id).slice().sort();
      operations.push({
        actor,
        error_code: null,
        ok: true,
        op: op.op,
        proposal_ids: ids,
        proposals_count: ids.length
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);

    operations.push({
      actor,
      error_code: r.body.error.code,
      ok: false,
      op: op.op,
      proposal_ids: null,
      proposals_count: null
    });
    continue;
  }

  if (op.op === 'cycleProposals.get') {
    const actor = actorRefs[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const proposalId = op.proposal_id ?? proposalByRef[op.proposal_ref]?.id;
    if (!proposalId) throw new Error(`missing proposal_id (proposal_ref=${op.proposal_ref ?? 'null'})`);

    const r = readSvc.get({ actor, proposalId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);

      operations.push({
        actor,
        error_code: null,
        ok: true,
        op: op.op,
        proposal_id: proposalId,
        returned_proposal_id: r.body.proposal?.id ?? null
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);

    operations.push({
      actor,
      error_code: r.body.error.code,
      ok: false,
      op: op.op,
      proposal_id: proposalId,
      returned_proposal_id: null
    });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const out = canonicalize({ operations });

writeFileSync(path.join(outDir, 'proposals_read_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M18', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
