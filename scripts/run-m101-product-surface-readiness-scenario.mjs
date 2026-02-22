import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { ProductSurfaceReadinessService } from '../src/service/productSurfaceReadinessService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M101';
const SCENARIO_FILE = 'fixtures/release/m101_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m101_expected.json';
const OUTPUT_FILE = 'product_surface_readiness_output.json';

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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
}

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

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));

function endpointFor(opId) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint for operation_id=${opId}`);
  return endpoint;
}

function validateApiRequest(opId, requestPayload) {
  const endpoint = endpointFor(opId);
  if (!endpoint.request_schema) return;
  const v = validateAgainstSchemaFile(endpoint.request_schema, requestPayload);
  if (!v.ok) throw new Error(`request invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
}

function validateApiResponse(opId, response) {
  const endpoint = endpointFor(opId);
  if (response.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!v.ok) throw new Error(`response invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
    return;
  }

  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

function applyExpectations(op, rec) {
  for (const [k, v] of Object.entries(op)) {
    if (!k.startsWith('expect_')) continue;
    const field = k.slice('expect_'.length);
    assert.deepEqual(rec[field], v, `expectation_failed op=${op.op} field=${field}`);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}
store.state.notification_preferences ||= {};
store.state.idempotency ||= {};

const service = new ProductSurfaceReadinessService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  const auth = op.auth ?? {};
  let response;
  let replayed = null;

  if (op.op === 'notifications.preferences.get') {
    response = service.getNotificationPreferences({ actor, auth });
  } else if (op.op === 'notifications.preferences.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const out = service.upsertNotificationPreferences({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      request
    });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'notifications.inbox.list') {
    response = service.listNotificationInbox({ actor, auth, query: clone(op.query ?? {}) });
  } else if (op.op === 'productProjection.inventory_awakening.get') {
    response = service.getInventoryAwakeningProjection({ actor, auth, query: clone(op.query ?? {}) });
  } else if (op.op === 'productProjection.cycle_inbox.list') {
    response = service.listCycleInboxProjection({ actor, auth, query: clone(op.query ?? {}) });
  } else if (op.op === 'productProjection.settlement_timeline.get') {
    response = service.getSettlementTimelineProjection({ actor, auth, cycleId: op.cycle_id, query: clone(op.query ?? {}) });
  } else if (op.op === 'productProjection.receipt_share.get') {
    response = service.getReceiptShareProjection({ actor, auth, receiptId: op.receipt_id, query: clone(op.query ?? {}) });
  } else if (op.op === 'partnerUi.capabilities.get') {
    response = service.getPartnerUiCapabilities({ actor, auth });
  } else if (op.op === 'partnerUi.bundle.get') {
    response = service.getPartnerUiBundle({ actor, auth, surface: op.surface, query: clone(op.query ?? {}) });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  validateApiResponse(op.op, response);

  const rec = {
    op: op.op,
    ok: response.ok,
    replayed,
    error_code: response.ok ? null : response.body.error.code,
    reason_code: response.ok ? null : reasonCodeFromError(response.body)
  };

  if (op.op === 'notifications.preferences.get' && response.ok) {
    rec.actor_type = response.body.preference?.actor?.type ?? null;
    rec.urgency_threshold = response.body.preference?.urgency_threshold ?? null;
    rec.demand_signal_opt_in = response.body.preference?.demand_signal_opt_in ?? null;
    rec.quiet_hours_enabled = response.body.preference?.quiet_hours?.enabled ?? null;
  }

  if (op.op === 'notifications.preferences.upsert' && response.ok) {
    rec.urgency_threshold = response.body.preference?.urgency_threshold ?? null;
    rec.demand_signal_opt_in = response.body.preference?.demand_signal_opt_in ?? null;
    rec.quiet_hours_enabled = response.body.preference?.quiet_hours?.enabled ?? null;
  }

  if (op.op === 'notifications.inbox.list' && response.ok) {
    rec.notifications_count = response.body.notifications?.length ?? 0;
    rec.total_filtered = response.body.total_filtered ?? null;
    rec.taxonomy_count = response.body.taxonomy?.length ?? 0;
    rec.first_type = response.body.notifications?.[0]?.type ?? null;
  }

  if (op.op === 'productProjection.inventory_awakening.get' && response.ok) {
    rec.intents_total = response.body.projection?.swappability_summary?.intents_total ?? null;
    rec.cycle_opportunities = response.body.projection?.swappability_summary?.cycle_opportunities ?? null;
    rec.average_confidence_bps = response.body.projection?.swappability_summary?.average_confidence_bps ?? null;
    rec.recommendations_count = response.body.projection?.recommended_first_intents?.length ?? 0;
  }

  if (op.op === 'productProjection.cycle_inbox.list' && response.ok) {
    rec.cards_count = response.body.cards?.length ?? 0;
    rec.total_filtered = response.body.total_filtered ?? null;
    rec.first_cycle_id = response.body.cards?.[0]?.cycle_id ?? null;
  }

  if (op.op === 'productProjection.settlement_timeline.get' && response.ok) {
    rec.cycle_id = response.body.digest?.cycle_id ?? null;
    rec.state = response.body.digest?.state ?? null;
    rec.next_required_action = response.body.digest?.next_required_action ?? null;
    rec.legs_total = response.body.digest?.progress?.legs_total ?? null;
  }

  if (op.op === 'productProjection.receipt_share.get' && response.ok) {
    rec.receipt_id = response.body.receipt_share?.receipt_id ?? null;
    rec.final_state = response.body.receipt_share?.final_state ?? null;
    rec.privacy_default_mode = response.body.receipt_share?.privacy?.default_mode ?? null;
  }

  if (op.op === 'partnerUi.capabilities.get' && response.ok) {
    rec.surfaces_count = response.body.capabilities?.surfaces?.length ?? 0;
    rec.first_surface = response.body.capabilities?.surfaces?.[0]?.surface ?? null;
  }

  if (op.op === 'partnerUi.bundle.get' && response.ok) {
    rec.surface = response.body.surface_bundle?.surface ?? null;
    rec.locale = response.body.surface_bundle?.locale ?? null;
    rec.required_operations_count = response.body.surface_bundle?.payload?.required_operations?.length ?? 0;
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const final = {
  notification_preferences_count: Object.keys(store.state.notification_preferences ?? {}).length,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length,
  notification_preference_subjects: Object.keys(store.state.notification_preferences ?? {}).sort(),
  receipt_ids: Object.values(store.state.receipts ?? {}).map(row => row?.id).filter(Boolean).sort()
};

const out = canonicalize({ operations, final });
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
