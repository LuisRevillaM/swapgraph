import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
import { PartnerProgramGovernanceService } from '../src/service/partnerProgramGovernanceService.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import {
  verifyPartnerProgramRolloutPolicyAuditExportPayload,
  verifyPartnerProgramRolloutPolicyAuditExportPayloadWithPublicKeyPem,
  verifyPartnerProgramRolloutPolicyDiagnosticsExportPayload,
  verifyPartnerProgramRolloutPolicyDiagnosticsExportPayloadWithPublicKeyPem,
  verifySettlementVaultReconciliationExportPayload,
  verifySettlementVaultReconciliationExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M61 scenario');
  process.exit(2);
}
if (process.env.SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE !== '1') {
  console.error('SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE must be 1 for M61 scenario');
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
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
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

const scenario = readJson(path.join(root, 'fixtures/vault/m61_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/vault/m61_expected.json'));

const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const settlementRead = new SettlementReadService({ store });
const governance = new PartnerProgramGovernanceService({ store });
const policyIntegrityKeysSvc = new PolicyIntegritySigningService();

const publicKeysById = new Map();
const auditExportRefs = {};
const diagnosticsExportRefs = {};
const settlementExportRefs = {};
const operations = [];

function endpointFor(operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint for operation_id=${operationId}`);
  return ep;
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

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'keys.policy_integrity_signing.get') {
    const response = policyIntegrityKeysSvc.getSigningKeys();
    validateApiResponse(op.op, response);

    for (const key of response.body?.keys ?? []) {
      if (key?.key_id && key?.public_key_pem) {
        publicKeysById.set(key.key_id, key.public_key_pem);
      }
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      keys_count: response.body?.keys?.length ?? 0,
      active_key_id: response.body?.active_key_id ?? null,
      key_statuses: Object.fromEntries((response.body?.keys ?? []).map(k => [k.key_id, k.status]))
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (op.expect_keys_count !== undefined) assert.equal(rec.keys_count, op.expect_keys_count);
    continue;
  }

  if (op.op === 'partner_program.configure') {
    const partnerId = String(op.partner_id ?? actors.partner?.id ?? '');
    if (!partnerId) throw new Error('partner_program.configure requires partner_id');

    store.state.partner_program ||= {};
    store.state.partner_program_usage ||= {};

    store.state.partner_program[partnerId] = {
      plan_id: op.plan_id ?? null,
      features: {
        vault_reconciliation_export: op.feature_enabled === true
      },
      quotas: {
        vault_reconciliation_export_daily: op.daily_limit ?? null
      }
    };

    if (op.reset_usage === true) {
      const prefix = `${partnerId}:`;
      for (const key of Object.keys(store.state.partner_program_usage)) {
        if (key.startsWith(prefix)) delete store.state.partner_program_usage[key];
      }
    }

    operations.push({
      op: op.op,
      partner_id: partnerId,
      plan_id: op.plan_id ?? null,
      feature_enabled: op.feature_enabled === true,
      daily_limit: op.daily_limit ?? null,
      reset_usage: op.reset_usage === true
    });

    continue;
  }

  if (op.op === 'rollout_overlay.set') {
    const cfg = op.config ?? {};

    if (Object.prototype.hasOwnProperty.call(cfg, 'freeze_export_enforce')) {
      if (cfg.freeze_export_enforce === null) delete process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE;
      else process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE = cfg.freeze_export_enforce ? '1' : '0';
    }

    operations.push({
      op: op.op,
      freeze_export_enforce: process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_FREEZE_EXPORT_ENFORCE === '1'
    });

    continue;
  }

  if (op.op === 'seed.vault_cycle') {
    const cycleId = String(op.cycle_id ?? 'cycle_m61');
    const partnerId = String(op.partner_id ?? actors.partner?.id ?? '');
    if (!cycleId || !partnerId) throw new Error('seed.vault_cycle requires cycle_id and partner_id');

    const legs = Array.isArray(op.legs) && op.legs.length > 0
      ? op.legs.map(leg => ({
          intent_id: leg.intent_id,
          status: leg.status ?? 'released',
          from_actor: leg.from_actor,
          to_actor: leg.to_actor,
          vault_holding_id: leg.vault_holding_id,
          vault_reservation_id: leg.vault_reservation_id
        }))
      : [
          {
            intent_id: 'intent_a',
            status: 'released',
            from_actor: { type: 'user', id: 'u1' },
            to_actor: { type: 'user', id: 'u2' },
            vault_holding_id: 'hold_a',
            vault_reservation_id: 'rsv_hold_a'
          },
          {
            intent_id: 'intent_b',
            status: 'released',
            from_actor: { type: 'user', id: 'u2' },
            to_actor: { type: 'user', id: 'u3' },
            vault_holding_id: 'hold_b',
            vault_reservation_id: 'rsv_hold_b'
          }
        ];

    store.state.timelines ||= {};
    store.state.timelines[cycleId] = {
      cycle_id: cycleId,
      state: op.timeline_state ?? 'completed',
      legs
    };

    store.state.tenancy ||= {};
    store.state.tenancy.cycles ||= {};
    store.state.tenancy.cycles[cycleId] = { partner_id: partnerId };

    store.state.vault_holdings ||= {};
    for (const leg of legs) {
      const holdingId = leg.vault_holding_id;
      if (!holdingId) continue;
      store.state.vault_holdings[holdingId] = {
        holding_id: holdingId,
        owner_actor: leg.from_actor,
        status: 'withdrawn',
        reservation_id: null,
        settlement_cycle_id: null,
        withdrawn_at: op.withdrawn_at ?? '2026-02-19T07:00:10Z'
      };
    }

    store.state.events ||= [];
    const baseTs = op.base_event_at ?? '2026-02-19T07:00:00Z';
    const transitions = op.transitions ?? [
      { from_state: 'escrow.pending', to_state: 'escrow.ready', reason_code: null, occurred_at: baseTs },
      { from_state: 'escrow.ready', to_state: 'executing', reason_code: null, occurred_at: '2026-02-19T07:00:05Z' },
      { from_state: 'executing', to_state: 'completed', reason_code: null, occurred_at: '2026-02-19T07:00:10Z' }
    ];

    for (const tr of transitions) {
      store.state.events.push({
        event_id: `evt_${cycleId}_${tr.to_state}_${tr.occurred_at}`,
        type: 'cycle.state_changed',
        occurred_at: tr.occurred_at,
        payload: {
          cycle_id: cycleId,
          from_state: tr.from_state,
          to_state: tr.to_state,
          reason_code: tr.reason_code ?? null
        }
      });
    }

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      legs_count: legs.length,
      timeline_state: store.state.timelines[cycleId].state,
      partner_id: partnerId
    });

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.get') {
    const response = settlementRead.vaultExportPartnerProgram({
      actor,
      auth: op.auth ?? {},
      query: op.query ?? {}
    });

    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      export_allowed: response.ok ? response.body.export_allowed : null,
      reasons: response.ok ? (response.body.reasons ?? []) : null,
      plan_id: response.ok ? (response.body.partner_program?.plan_id ?? null) : null,
      quota_daily_limit: response.ok ? (response.body.partner_program?.quota_daily_limit ?? null) : null,
      quota_daily_used: response.ok ? (response.body.partner_program?.quota_daily_used ?? null) : null,
      freeze_export_enforced: response.ok ? (response.body.rollout_policy?.freeze_export_enforced ?? null) : null,
      policy_source: response.ok ? (response.body.rollout_policy?.policy_source ?? null) : null,
      policy_version: response.ok ? (response.body.rollout_policy?.policy_version ?? null) : null,
      policy_updated_at: response.ok ? (response.body.rollout_policy?.policy_updated_at ?? null) : null,
      policy_updated_by: response.ok ? (response.body.rollout_policy?.policy_updated_by ?? null) : null,
      maintenance_mode_enabled: response.ok ? (response.body.rollout_policy?.maintenance_mode_enabled ?? null) : null,
      maintenance_reason_code: response.ok ? (response.body.rollout_policy?.maintenance_reason_code ?? null) : null,
      freeze_until: response.ok ? (response.body.rollout_policy?.freeze_until ?? null) : null,
      freeze_reason_code: response.ok ? (response.body.rollout_policy?.freeze_reason_code ?? null) : null,
      freeze_active: response.ok ? (response.body.rollout_policy?.freeze_active ?? null) : null,
      last_admin_action_at: response.ok ? (response.body.rollout_policy?.last_admin_action_at ?? null) : null,
      last_admin_action_by: response.ok ? (response.body.rollout_policy?.last_admin_action_by ?? null) : null,
      allowlist_enforced: response.ok ? (response.body.rollout_policy?.allowlist_enforced ?? null) : null,
      partner_allowed: response.ok ? (response.body.rollout_policy?.partner_allowed ?? null) : null,
      min_plan_id: response.ok ? (response.body.rollout_policy?.min_plan_id ?? null) : null,
      plan_meets_minimum: response.ok ? (response.body.rollout_policy?.plan_meets_minimum ?? null) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (typeof op.expect_export_allowed === 'boolean') assert.equal(rec.export_allowed, op.expect_export_allowed);
    if (Array.isArray(op.expect_reasons)) assert.deepEqual(rec.reasons, op.expect_reasons);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_plan_id')) assert.equal(rec.plan_id, op.expect_plan_id);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_quota_daily_limit')) assert.equal(rec.quota_daily_limit, op.expect_quota_daily_limit);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_quota_daily_used')) assert.equal(rec.quota_daily_used, op.expect_quota_daily_used);
    if (typeof op.expect_allowlist_enforced === 'boolean') assert.equal(rec.allowlist_enforced, op.expect_allowlist_enforced);
    if (typeof op.expect_partner_allowed === 'boolean') assert.equal(rec.partner_allowed, op.expect_partner_allowed);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_min_plan_id')) assert.equal(rec.min_plan_id, op.expect_min_plan_id);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_plan_meets_minimum')) assert.equal(rec.plan_meets_minimum, op.expect_plan_meets_minimum);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_export_enforced')) assert.equal(rec.freeze_export_enforced, op.expect_freeze_export_enforced);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_source')) assert.equal(rec.policy_source, op.expect_policy_source);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_version')) assert.equal(rec.policy_version, op.expect_policy_version);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_updated_at')) assert.equal(rec.policy_updated_at, op.expect_policy_updated_at);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_updated_by')) assert.deepEqual(rec.policy_updated_by, op.expect_policy_updated_by);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_mode_enabled')) assert.equal(rec.maintenance_mode_enabled, op.expect_maintenance_mode_enabled);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_reason_code')) assert.equal(rec.maintenance_reason_code, op.expect_maintenance_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_until')) assert.equal(rec.freeze_until, op.expect_freeze_until);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_reason_code')) assert.equal(rec.freeze_reason_code, op.expect_freeze_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_active')) assert.equal(rec.freeze_active, op.expect_freeze_active);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_last_admin_action_at')) assert.equal(rec.last_admin_action_at, op.expect_last_admin_action_at);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_last_admin_action_by')) assert.deepEqual(rec.last_admin_action_by, op.expect_last_admin_action_by);

    continue;
  }

  if (op.op === 'settlement.vault_reconciliation.export') {
    const cycleId = String(op.cycle_id ?? '');
    if (!cycleId) throw new Error('settlement.vault_reconciliation.export requires cycle_id');

    const query = clone(op.query ?? {});

    const response = settlementRead.vaultReconciliationExport({
      actor,
      auth: op.auth ?? {},
      cycleId,
      query
    });

    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) {
      settlementExportRefs[op.save_export_ref] = response.body;
    }

    const rec = {
      op: op.op,
      actor,
      cycle_id: cycleId,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      entries_count: response.ok ? (response.body.vault_reconciliation?.entries?.length ?? 0) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_entries_count')) assert.equal(rec.entries_count, op.expect_entries_count);

    continue;
  }

  if (op.op === 'settlement.vault_reconciliation.export.verify') {
    const payload = settlementExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing settlement export_ref: ${op.export_ref}`);

    const verified = verifySettlementVaultReconciliationExportPayload(payload);

    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifySettlementVaultReconciliationExportPayloadWithPublicKeyPem({
          payload,
          publicKeyPem,
          keyId,
          alg: payload.signature?.alg
        })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };
    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(rec.verify_public_ok, op.expect_verify_public_ok);

    continue;
  }

  if (op.op === 'settlement.vault_reconciliation.export.verify_tampered') {
    const payload = settlementExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing settlement export_ref: ${op.export_ref}`);

    const tampered = clone(payload);
    const h = String(tampered?.export_hash ?? '');
    const suffix = h.endsWith('0') ? '1' : '0';
    tampered.export_hash = `${h.slice(0, Math.max(0, h.length - 1))}${suffix}`;

    const verified = verifySettlementVaultReconciliationExportPayload(tampered);

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };
    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (op.expect_verify_error) assert.equal(rec.verify_error, op.expect_verify_error);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy.get') {
    const response = governance.getVaultExportRolloutPolicy({
      actor,
      auth: op.auth ?? {}
    });

    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      source: response.ok ? (response.body.policy?.source ?? null) : null,
      allowlist: response.ok ? (response.body.policy?.allowlist ?? []) : null,
      min_plan_id: response.ok ? (response.body.policy?.min_plan_id ?? null) : null,
      version: response.ok ? (response.body.policy?.version ?? null) : null,
      updated_at: response.ok ? (response.body.policy?.updated_at ?? null) : null,
      updated_by: response.ok ? (response.body.policy?.updated_by ?? null) : null,
      maintenance_mode_enabled: response.ok ? (response.body.policy?.controls?.maintenance_mode_enabled ?? null) : null,
      maintenance_reason_code: response.ok ? (response.body.policy?.controls?.maintenance_reason_code ?? null) : null,
      freeze_until: response.ok ? (response.body.policy?.controls?.freeze_until ?? null) : null,
      freeze_reason_code: response.ok ? (response.body.policy?.controls?.freeze_reason_code ?? null) : null,
      freeze_active: response.ok ? (response.body.policy?.controls?.freeze_active ?? null) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_source')) assert.equal(rec.source, op.expect_source);
    if (Array.isArray(op.expect_allowlist)) assert.deepEqual(rec.allowlist, op.expect_allowlist);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_min_plan_id')) assert.equal(rec.min_plan_id, op.expect_min_plan_id);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_version')) assert.equal(rec.version, op.expect_version);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_mode_enabled')) assert.equal(rec.maintenance_mode_enabled, op.expect_maintenance_mode_enabled);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_reason_code')) assert.equal(rec.maintenance_reason_code, op.expect_maintenance_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_until')) assert.equal(rec.freeze_until, op.expect_freeze_until);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_reason_code')) assert.equal(rec.freeze_reason_code, op.expect_freeze_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_active')) assert.equal(rec.freeze_active, op.expect_freeze_active);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy.upsert') {
    const request = clone(op.request ?? {});
    validateApiRequest(op.op, request);

    const r = governance.upsertVaultExportRolloutPolicy({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      requestBody: request,
      occurredAt: op.occurred_at
    });

    const response = r.result;
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      replayed: r.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      policy_source: response.ok ? (response.body.policy?.source ?? null) : null,
      policy_allowlist: response.ok ? (response.body.policy?.allowlist ?? null) : null,
      policy_min_plan_id: response.ok ? (response.body.policy?.min_plan_id ?? null) : null,
      policy_version: response.ok ? (response.body.policy?.version ?? null) : null,
      audit_id: response.ok ? (response.body.audit_entry?.audit_id ?? null) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (typeof op.expect_replayed === 'boolean') assert.equal(rec.replayed, op.expect_replayed);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_source')) assert.equal(rec.policy_source, op.expect_policy_source);
    if (Array.isArray(op.expect_policy_allowlist)) assert.deepEqual(rec.policy_allowlist, op.expect_policy_allowlist);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_min_plan_id')) assert.equal(rec.policy_min_plan_id, op.expect_policy_min_plan_id);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_version')) assert.equal(rec.policy_version, op.expect_policy_version);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_audit_id')) assert.equal(rec.audit_id, op.expect_audit_id);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy.admin_action') {
    const request = clone(op.request ?? {});
    validateApiRequest(op.op, request);

    const r = governance.adminActionVaultExportRolloutPolicy({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      requestBody: request,
      occurredAt: op.occurred_at
    });

    const response = r.result;
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      replayed: r.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      policy_source: response.ok ? (response.body.policy?.source ?? null) : null,
      policy_version: response.ok ? (response.body.policy?.version ?? null) : null,
      maintenance_mode_enabled: response.ok ? (response.body.policy?.controls?.maintenance_mode_enabled ?? null) : null,
      maintenance_reason_code: response.ok ? (response.body.policy?.controls?.maintenance_reason_code ?? null) : null,
      freeze_until: response.ok ? (response.body.policy?.controls?.freeze_until ?? null) : null,
      freeze_reason_code: response.ok ? (response.body.policy?.controls?.freeze_reason_code ?? null) : null,
      audit_id: response.ok ? (response.body.audit_entry?.audit_id ?? null) : null,
      audit_action_type: response.ok ? (response.body.audit_entry?.admin_action?.action_type ?? null) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (typeof op.expect_replayed === 'boolean') assert.equal(rec.replayed, op.expect_replayed);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_source')) assert.equal(rec.policy_source, op.expect_policy_source);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_version')) assert.equal(rec.policy_version, op.expect_policy_version);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_mode_enabled')) assert.equal(rec.maintenance_mode_enabled, op.expect_maintenance_mode_enabled);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_reason_code')) assert.equal(rec.maintenance_reason_code, op.expect_maintenance_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_until')) assert.equal(rec.freeze_until, op.expect_freeze_until);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_reason_code')) assert.equal(rec.freeze_reason_code, op.expect_freeze_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_audit_id')) assert.equal(rec.audit_id, op.expect_audit_id);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_audit_action_type')) assert.equal(rec.audit_action_type, op.expect_audit_action_type);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy.diagnostics.export') {
    const query = clone(op.query ?? {});

    const response = governance.exportVaultExportRolloutPolicyDiagnostics({
      actor,
      auth: op.auth ?? {},
      query
    });

    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) {
      diagnosticsExportRefs[op.save_export_ref] = response.body;
    }

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null,
      policy_version: response.ok ? (response.body.policy?.version ?? null) : null,
      maintenance_mode_enabled: response.ok ? (response.body.policy?.controls?.maintenance_mode_enabled ?? null) : null,
      freeze_active: response.ok ? (response.body.policy?.controls?.freeze_active ?? null) : null,
      freeze_export_enforced: response.ok ? (response.body.overlays?.freeze_export_enforced ?? null) : null,
      partner_program_enforced: response.ok ? (response.body.overlays?.partner_program_enforced ?? null) : null,
      recommended_action_codes: response.ok ? (response.body.recommended_actions ?? []).map(x => x.code) : null,
      runbook_hook_ids: response.ok ? (response.body.runbook_hooks ?? []).map(x => x.hook_id) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_version')) assert.equal(rec.policy_version, op.expect_policy_version);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_mode_enabled')) assert.equal(rec.maintenance_mode_enabled, op.expect_maintenance_mode_enabled);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_active')) assert.equal(rec.freeze_active, op.expect_freeze_active);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_export_enforced')) assert.equal(rec.freeze_export_enforced, op.expect_freeze_export_enforced);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_partner_program_enforced')) assert.equal(rec.partner_program_enforced, op.expect_partner_program_enforced);
    if (Array.isArray(op.expect_recommended_action_codes)) assert.deepEqual(rec.recommended_action_codes, op.expect_recommended_action_codes);
    if (Array.isArray(op.expect_runbook_hook_ids)) assert.deepEqual(rec.runbook_hook_ids, op.expect_runbook_hook_ids);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify') {
    const payload = diagnosticsExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing diagnostics export_ref: ${op.export_ref}`);

    const verified = verifyPartnerProgramRolloutPolicyDiagnosticsExportPayload(payload);

    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramRolloutPolicyDiagnosticsExportPayloadWithPublicKeyPem({
          payload,
          publicKeyPem,
          keyId,
          alg: payload.signature?.alg
        })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };
    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(rec.verify_public_ok, op.expect_verify_public_ok);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify_tampered') {
    const payload = diagnosticsExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing diagnostics export_ref: ${op.export_ref}`);

    const tampered = clone(payload);
    const h = String(tampered?.export_hash ?? '');
    const suffix = h.endsWith('0') ? '1' : '0';
    tampered.export_hash = `${h.slice(0, Math.max(0, h.length - 1))}${suffix}`;

    const verified = verifyPartnerProgramRolloutPolicyDiagnosticsExportPayload(tampered);

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };
    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (op.expect_verify_error) assert.equal(rec.verify_error, op.expect_verify_error);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy_audit.export') {
    const query = clone(op.query ?? {});
    if (op.attestation_after_ref) {
      const prior = auditExportRefs[op.attestation_after_ref];
      if (!prior) throw new Error(`missing attestation_after_ref export: ${op.attestation_after_ref}`);
      query.attestation_after = prior?.attestation?.chain_hash ?? null;
    }
    if (op.checkpoint_after_ref) {
      const prior = auditExportRefs[op.checkpoint_after_ref];
      if (!prior) throw new Error(`missing checkpoint_after_ref export: ${op.checkpoint_after_ref}`);
      query.checkpoint_after = prior?.checkpoint?.checkpoint_hash ?? null;
    }

    const response = governance.exportVaultExportRolloutPolicyAudit({
      actor,
      auth: op.auth ?? {},
      query
    });

    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) {
      auditExportRefs[op.save_export_ref] = response.body;
    }

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      entries_count: response.ok ? (response.body.entries?.length ?? 0) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      attestation_after: response.ok ? (response.body.attestation?.attestation_after ?? null) : null,
      attestation_chain_hash: response.ok ? (response.body.attestation?.chain_hash ?? null) : null,
      checkpoint_after: response.ok ? (response.body.checkpoint?.checkpoint_after ?? null) : null,
      checkpoint_hash: response.ok ? (response.body.checkpoint?.checkpoint_hash ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null,
      policy_version: response.ok ? (response.body.policy?.version ?? null) : null
    };
    operations.push(rec);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(rec.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_entries_count')) assert.equal(rec.entries_count, op.expect_entries_count);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_total_filtered')) assert.equal(rec.total_filtered, op.expect_total_filtered);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_next_cursor')) assert.equal(rec.next_cursor, op.expect_next_cursor);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_policy_version')) assert.equal(rec.policy_version, op.expect_policy_version);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_attestation_after')) assert.equal(rec.attestation_after, op.expect_attestation_after);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_attestation_chain_hash')) assert.equal(rec.attestation_chain_hash, op.expect_attestation_chain_hash);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_checkpoint_after')) assert.equal(rec.checkpoint_after, op.expect_checkpoint_after);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_checkpoint_hash')) assert.equal(rec.checkpoint_hash, op.expect_checkpoint_hash);

    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy_audit.export.verify') {
    const payload = auditExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const verified = verifyPartnerProgramRolloutPolicyAuditExportPayload(payload);

    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramRolloutPolicyAuditExportPayloadWithPublicKeyPem({
          payload,
          publicKeyPem,
          keyId,
          alg: payload.signature?.alg
        })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };
    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(rec.verify_public_ok, op.expect_verify_public_ok);
    continue;
  }

  if (op.op === 'partnerProgram.vault_export.rollout_policy_audit.export.verify_tampered') {
    const payload = auditExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const tampered = clone(payload);
    const h = String(tampered?.export_hash ?? '');
    const suffix = h.endsWith('0') ? '1' : '0';
    tampered.export_hash = `${h.slice(0, Math.max(0, h.length - 1))}${suffix}`;

    const verified = verifyPartnerProgramRolloutPolicyAuditExportPayload(tampered);

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };
    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (op.expect_verify_error) assert.equal(rec.verify_error, op.expect_verify_error);

    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const rolloutPolicy = store.state.partner_program_rollout_policy?.vault_reconciliation_export ?? null;
const rolloutPolicyAudit = (store.state.partner_program_rollout_policy_audit ?? []).map(entry => ({
  audit_id: entry.audit_id,
  operation_id: entry.operation_id ?? null,
  occurred_at: entry.occurred_at,
  actor_id: entry.actor?.id ?? null,
  allowlist_after: entry.policy_after?.allowlist ?? [],
  min_plan_after: entry.policy_after?.min_plan_id ?? null,
  maintenance_mode_after: entry.policy_after?.controls?.maintenance_mode_enabled ?? false,
  freeze_until_after: entry.policy_after?.controls?.freeze_until ?? null,
  version_after: entry.policy_after?.version ?? null,
  admin_action_type: entry.admin_action?.action_type ?? null
}));

const partnerPrograms = store.state.partner_program ?? {};
const partnerProgramRecords = Object.keys(partnerPrograms).sort().map(partnerId => ({
  partner_id: partnerId,
  plan_id: partnerPrograms[partnerId]?.plan_id ?? null,
  feature_vault_reconciliation_export: partnerPrograms[partnerId]?.features?.vault_reconciliation_export === true,
  quota_vault_reconciliation_export_daily: partnerPrograms[partnerId]?.quotas?.vault_reconciliation_export_daily ?? null
}));

const partnerProgramUsage = store.state.partner_program_usage ?? {};
const partnerProgramUsageRecords = Object.keys(partnerProgramUsage).sort().map(key => ({
  usage_key: key,
  used: partnerProgramUsage[key]
}));

const idempotencyRecords = Object.entries(store.state.idempotency ?? {})
  .filter(([key]) => key.includes('partnerProgram.vault_export.rollout_policy.upsert') || key.includes('partnerProgram.vault_export.rollout_policy.admin_action'))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => ({
    scope_key: key,
    payload_hash: value?.payload_hash ?? null,
    ok: value?.result?.ok ?? null,
    error_code: value?.result?.ok ? null : (value?.result?.body?.error?.code ?? null)
  }));

const checkpointState = store.state.partner_program_rollout_policy_export_checkpoints ?? {};
const checkpointKeys = Object.keys(checkpointState).sort();
const checkpointRecords = checkpointKeys.map(key => ({
  checkpoint_hash: key,
  checkpoint_after: checkpointState[key]?.checkpoint_after ?? null,
  next_cursor: checkpointState[key]?.next_cursor ?? null,
  attestation_chain_hash: checkpointState[key]?.attestation_chain_hash ?? null,
  query_context: checkpointState[key]?.query_context ?? null,
  exported_at: checkpointState[key]?.exported_at ?? null
}));

const out = canonicalize({
  operations,
  final: {
    rollout_policy: rolloutPolicy,
    rollout_policy_audit: rolloutPolicyAudit,
    checkpoint_keys: checkpointKeys,
    checkpoint_records: checkpointRecords,
    partner_program_records: partnerProgramRecords,
    partner_program_usage: partnerProgramUsageRecords,
    idempotency: idempotencyRecords
  }
});

writeFileSync(path.join(outDir, 'rollout_diagnostics_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M61', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, audit_entries: rolloutPolicyAudit.length, checkpoints: checkpointKeys.length } }, null, 2));
