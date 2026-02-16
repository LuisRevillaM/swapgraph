import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { CommitService } from '../src/commit/commitService.mjs';
import { SettlementService } from '../src/settlement/settlementService.mjs';
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

// --- Load schemas ---
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateBySchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

// --- Events manifest ---
const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const typeToSchemaFile = new Map((eventsManifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

function validateEvent(evt) {
  const env = validateBySchemaFile(eventsManifest.event_envelope_schema, evt);
  const schemaFile = typeToSchemaFile.get(evt.type);
  if (!schemaFile) {
    return { event_id: evt.event_id, type: evt.type, envelope_ok: env.ok, payload_ok: false, envelope_errors: env.errors, payload_errors: [{ message: `unknown event type ${evt.type}` }] };
  }
  const payload = validateBySchemaFile(schemaFile, evt.payload);
  return {
    event_id: evt.event_id,
    type: evt.type,
    envelope_ok: env.ok,
    payload_ok: payload.ok,
    envelope_errors: env.errors,
    payload_errors: payload.errors
  };
}

// --- Seed intents from fixture ---
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

for (const it of matchingInput.intents) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateBySchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

// Proposals from matching fixture output
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const p3 = proposals.find(p => p.participants.length === 3);
const p2 = proposals.find(p => p.participants.length === 2);
if (!p3 || !p2) throw new Error('expected both a 3-cycle and 2-cycle proposal in fixtures');

const proposalByRef = { p3, p2 };

const scenario = readJson(path.join(root, 'fixtures/settlement/m11_scenario.json'));

const commitSvc = new CommitService({ store });
const settlementSvc = new SettlementService({ store });

const opsResults = [];

for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.accept') {
    const proposal = proposalByRef[op.proposal_ref];
    const req = { proposal_id: proposal.id };
    const r = commitSvc.accept({ actor: op.actor, idempotencyKey: op.idempotency_key, proposal, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;
    opsResults.push({ op: op.op, proposal_id: proposal.id, ok: res.ok, replayed: r.replayed, error_code: res.ok ? null : res.body.error.code, commit_phase: res.ok ? res.body.commit.phase : null });
    continue;
  }

  if (op.op === 'settlement.start') {
    const proposal = proposalByRef[op.proposal_ref];
    const depositDeadlineAt = scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at;
    const r = settlementSvc.start({ actor: op.actor, proposal, occurredAt: op.occurred_at, depositDeadlineAt });
    if (!r.ok) throw new Error(`settlement.start failed: ${JSON.stringify(r)}`);
    opsResults.push({ op: op.op, cycle_id: proposal.id, ok: true, replayed: r.replayed, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.deposit_confirmed') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.confirmDeposit({ actor: op.actor, cycleId: proposal.id, depositRef: op.deposit_ref, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`confirmDeposit failed: ${JSON.stringify(r)}`);
    opsResults.push({ op: op.op, cycle_id: proposal.id, ok: true, replayed: r.replayed ?? false, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.begin_execution') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.beginExecution({ actor: op.actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`beginExecution failed: ${JSON.stringify(r)}`);
    opsResults.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.complete') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.complete({ actor: op.actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`complete failed: ${JSON.stringify(r)}`);
    opsResults.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: r.timeline.state, receipt_id: r.receipt.id, final_state: r.receipt.final_state });
    continue;
  }

  if (op.op === 'settlement.expire_deposit_window') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.expireDepositWindow({ actor: op.actor, cycleId: proposal.id, nowIso: op.now_iso });
    if (!r.ok) throw new Error(`expireDepositWindow failed: ${JSON.stringify(r)}`);

    const timeline = store.state.timelines[proposal.id];
    const receipt = store.state.receipts[proposal.id];
    opsResults.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: timeline.state, receipt_id: receipt.id, final_state: receipt.final_state });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const storeReload = new JsonStateStore({ filePath: storeFile });
storeReload.load();

const events = storeReload.state.events;
const validations = events.map(validateEvent);
const overall = validations.every(v => v.envelope_ok && v.payload_ok);
if (!overall) {
  writeFileSync(path.join(outDir, 'events_validation.json'), JSON.stringify({ overall: false, validations }, null, 2));
  throw new Error('event validation failed');
}

const byType = {};
for (const evt of events) {
  byType[evt.type] = (byType[evt.type] ?? 0) + 1;
}

const depositRequired = events
  .filter(e => e.type === 'settlement.deposit_required')
  .map(e => ({ event_id: e.event_id, cycle_id: e.payload.cycle_id, deposit_deadline_at: e.payload.deposit_deadline_at }))
  .sort((a, b) => a.cycle_id.localeCompare(b.cycle_id));

const depositConfirmed = events
  .filter(e => e.type === 'settlement.deposit_confirmed')
  .map(e => ({ event_id: e.event_id, cycle_id: e.payload.cycle_id, intent_id: e.payload.intent_id, deposit_ref: e.payload.deposit_ref }))
  .sort((a, b) => a.cycle_id.localeCompare(b.cycle_id) || a.intent_id.localeCompare(b.intent_id));

const executing = events
  .filter(e => e.type === 'settlement.executing')
  .map(e => ({ event_id: e.event_id, cycle_id: e.payload.cycle_id }))
  .sort((a, b) => a.cycle_id.localeCompare(b.cycle_id));

const out = canonicalize({
  operations: opsResults,
  settlement_events: {
    deposit_required: depositRequired,
    deposit_confirmed: depositConfirmed,
    executing
  },
  stats: {
    events_total: events.length,
    events_unique: new Set(events.map(e => e.event_id)).size,
    by_type: byType
  }
});

// Proof outputs
writeFileSync(path.join(outDir, 'settlement_events_output.json'), JSON.stringify(out, null, 2));
writeFileSync(path.join(outDir, 'events_outbox.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(path.join(outDir, 'events_validation.json'), JSON.stringify({ overall: true, validations }, null, 2));

// Expected snapshot
const expectedPath = path.join(root, 'fixtures/settlement/m11_expected.json');
const expected = readJson(expectedPath);
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M11', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: out.stats }, null, 2));
