import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
import { PartnerProgramGovernanceService } from '../src/service/partnerProgramGovernanceService.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import {
  buildSignedPartnerProgramRolloutPolicyDiagnosticsExportPayload,
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
  console.error('AUTHZ_ENFORCE must be 1 for M72 scenario');
  process.exit(2);
}
if (process.env.SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE !== '1') {
  console.error('SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE must be 1 for M72 scenario');
  process.exit(2);
}
if (process.env.PARTNER_PROGRAM_ROLLOUT_POLICY_DIAGNOSTICS_EXPORT_CHECKPOINT_ENFORCE !== '1') {
  console.error('PARTNER_PROGRAM_ROLLOUT_POLICY_DIAGNOSTICS_EXPORT_CHECKPOINT_ENFORCE must be 1 for M72 scenario');
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

const scenario = readJson(path.join(root, 'fixtures/rollout/m72_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/rollout/m72_expected.json'));

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
    const cycleId = String(op.cycle_id ?? 'cycle_m72');
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
    if (op.attestation_after_ref) {
      const prior = diagnosticsExportRefs[op.attestation_after_ref];
      if (!prior) throw new Error(`missing diagnostics attestation_after_ref export: ${op.attestation_after_ref}`);
      query.attestation_after = prior?.attestation?.chain_hash ?? null;
    }
    if (op.checkpoint_after_ref) {
      const prior = diagnosticsExportRefs[op.checkpoint_after_ref];
      if (!prior) throw new Error(`missing diagnostics checkpoint_after_ref export: ${op.checkpoint_after_ref}`);
      query.checkpoint_after = prior?.checkpoint?.checkpoint_hash ?? null;
    }

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
      include_recommended_actions: response.ok ? (response.body.query?.include_recommended_actions ?? null) : null,
      include_runbook_hooks: response.ok ? (response.body.query?.include_runbook_hooks ?? null) : null,
      include_automation_hints: response.ok ? (response.body.query?.include_automation_hints ?? null) : null,
      maintenance_stale_after_minutes: response.ok ? (response.body.query?.maintenance_stale_after_minutes ?? null) : null,
      freeze_expiring_soon_minutes: response.ok ? (response.body.query?.freeze_expiring_soon_minutes ?? null) : null,
      automation_max_actions: response.ok ? (response.body.query?.automation_max_actions ?? null) : null,
      lifecycle_maintenance_mode_age_minutes: response.ok ? (response.body.lifecycle_signals?.maintenance_mode_age_minutes ?? null) : null,
      lifecycle_freeze_window_remaining_minutes: response.ok ? (response.body.lifecycle_signals?.freeze_window_remaining_minutes ?? null) : null,
      lifecycle_freeze_window_remaining_bucket: response.ok ? (response.body.lifecycle_signals?.freeze_window_remaining_bucket ?? null) : null,
      alert_codes: response.ok ? (response.body.alerts ?? []).map(x => x.code) : null,
      automation_requires_operator_confirmation: response.ok ? (response.body.automation_hints?.requires_operator_confirmation ?? null) : null,
      automation_source_alert_codes: response.ok ? (response.body.automation_hints?.source_alert_codes ?? null) : null,
      automation_action_hook_ids: response.ok ? (response.body.automation_hints?.action_queue ?? []).map(x => x.hook_id) : null,
      automation_action_reason_codes: response.ok ? (response.body.automation_hints?.action_queue ?? []).map(x => x.reason_code) : null,
      automation_action_priorities: response.ok ? (response.body.automation_hints?.action_queue ?? []).map(x => x.priority) : null,
      automation_request_steps: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x.step) : null,
      automation_request_hook_ids: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x.hook_id) : null,
      automation_request_operation_ids: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x.operation_id) : null,
      automation_request_idempotency_templates: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x.idempotency_key_template) : null,
      automation_request_action_types: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x?.request?.action?.action_type ?? null) : null,
      automation_request_hashes: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x?.request_hash ?? null) : null,
      automation_expected_policy_versions: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x?.expected_effect?.policy_version_after ?? null) : null,
      automation_expected_maintenance_modes: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x?.expected_effect?.maintenance_mode_enabled ?? null) : null,
      automation_expected_freeze_until: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x?.expected_effect?.freeze_until ?? null) : null,
      automation_expected_freeze_active: response.ok ? (response.body.automation_hints?.action_requests ?? []).map(x => x?.expected_effect?.freeze_active ?? null) : null,
      automation_plan_hash: response.ok ? (response.body.automation_hints?.plan_hash ?? null) : null,
      automation_execution_policy_version_before: response.ok ? (response.body.automation_hints?.execution_attestation?.policy_version_before ?? null) : null,
      automation_execution_policy_version_after_expected: response.ok ? (response.body.automation_hints?.execution_attestation?.policy_version_after_expected ?? null) : null,
      automation_execution_non_empty_action_plan: response.ok ? (response.body.automation_hints?.execution_attestation?.non_empty_action_plan ?? null) : null,
      automation_execution_expected_effect_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.expected_effect_hash ?? null) : null,
      automation_execution_request_hash_chain: response.ok ? (response.body.automation_hints?.execution_attestation?.request_hash_chain ?? null) : null,
      automation_execution_attestation_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.attestation_hash ?? null) : null,
      automation_execution_continuation_attestation_after: response.ok ? (response.body.automation_hints?.execution_attestation?.continuation_attestation_after ?? null) : null,
      automation_execution_continuation_checkpoint_after: response.ok ? (response.body.automation_hints?.execution_attestation?.continuation_checkpoint_after ?? null) : null,
      automation_execution_continuation_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.continuation_hash ?? null) : null,
      automation_execution_continuation_window_minutes: response.ok ? (response.body.automation_hints?.execution_attestation?.continuation_window_minutes ?? null) : null,
      automation_execution_continuation_expires_at: response.ok ? (response.body.automation_hints?.execution_attestation?.continuation_expires_at ?? null) : null,
      automation_execution_receipt_steps_count: response.ok ? (response.body.automation_hints?.execution_attestation?.receipt_steps_count ?? null) : null,
      automation_execution_receipt_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.receipt_hash ?? null) : null,
      automation_execution_journal_entry_hashes: response.ok ? (response.body.automation_hints?.execution_attestation?.journal_entry_hashes ?? null) : null,
      automation_execution_journal_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.journal_hash ?? null) : null,
      automation_execution_rollback_target_policy_version: response.ok ? (response.body.automation_hints?.execution_attestation?.rollback_target_policy_version ?? null) : null,
      automation_execution_rollback_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.rollback_hash ?? null) : null,
      automation_execution_simulation_projected_policy_version_after: response.ok ? (response.body.automation_hints?.execution_attestation?.simulation_projected_policy_version_after ?? null) : null,
      automation_execution_simulation_risk_level: response.ok ? (response.body.automation_hints?.execution_attestation?.simulation_risk_level ?? null) : null,
      automation_execution_simulation_hash: response.ok ? (response.body.automation_hints?.execution_attestation?.simulation_hash ?? null) : null,
      automation_idempotency_scope: response.ok ? (response.body.automation_hints?.safety?.idempotency_scope ?? null) : null,
      automation_max_actions_per_run: response.ok ? (response.body.automation_hints?.safety?.max_actions_per_run ?? null) : null,
      attestation_after: response.ok ? (response.body.attestation?.attestation_after ?? null) : null,
      attestation_chain_hash: response.ok ? (response.body.attestation?.chain_hash ?? null) : null,
      checkpoint_after: response.ok ? (response.body.checkpoint?.checkpoint_after ?? null) : null,
      checkpoint_hash: response.ok ? (response.body.checkpoint?.checkpoint_hash ?? null) : null,
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
    if (Object.prototype.hasOwnProperty.call(op, 'expect_include_recommended_actions')) assert.equal(rec.include_recommended_actions, op.expect_include_recommended_actions);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_include_runbook_hooks')) assert.equal(rec.include_runbook_hooks, op.expect_include_runbook_hooks);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_include_automation_hints')) assert.equal(rec.include_automation_hints, op.expect_include_automation_hints);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_maintenance_stale_after_minutes')) assert.equal(rec.maintenance_stale_after_minutes, op.expect_maintenance_stale_after_minutes);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_freeze_expiring_soon_minutes')) assert.equal(rec.freeze_expiring_soon_minutes, op.expect_freeze_expiring_soon_minutes);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_max_actions')) assert.equal(rec.automation_max_actions, op.expect_automation_max_actions);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_lifecycle_maintenance_mode_age_minutes')) assert.equal(rec.lifecycle_maintenance_mode_age_minutes, op.expect_lifecycle_maintenance_mode_age_minutes);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_lifecycle_freeze_window_remaining_minutes')) assert.equal(rec.lifecycle_freeze_window_remaining_minutes, op.expect_lifecycle_freeze_window_remaining_minutes);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_lifecycle_freeze_window_remaining_bucket')) assert.equal(rec.lifecycle_freeze_window_remaining_bucket, op.expect_lifecycle_freeze_window_remaining_bucket);
    if (Array.isArray(op.expect_alert_codes)) assert.deepEqual(rec.alert_codes, op.expect_alert_codes);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_requires_operator_confirmation')) assert.equal(rec.automation_requires_operator_confirmation, op.expect_automation_requires_operator_confirmation);
    if (Array.isArray(op.expect_automation_source_alert_codes)) assert.deepEqual(rec.automation_source_alert_codes, op.expect_automation_source_alert_codes);
    if (Array.isArray(op.expect_automation_action_hook_ids)) assert.deepEqual(rec.automation_action_hook_ids, op.expect_automation_action_hook_ids);
    if (Array.isArray(op.expect_automation_action_reason_codes)) assert.deepEqual(rec.automation_action_reason_codes, op.expect_automation_action_reason_codes);
    if (Array.isArray(op.expect_automation_action_priorities)) assert.deepEqual(rec.automation_action_priorities, op.expect_automation_action_priorities);
    if (Array.isArray(op.expect_automation_request_steps)) assert.deepEqual(rec.automation_request_steps, op.expect_automation_request_steps);
    if (Array.isArray(op.expect_automation_request_hook_ids)) assert.deepEqual(rec.automation_request_hook_ids, op.expect_automation_request_hook_ids);
    if (Array.isArray(op.expect_automation_request_operation_ids)) assert.deepEqual(rec.automation_request_operation_ids, op.expect_automation_request_operation_ids);
    if (Array.isArray(op.expect_automation_request_idempotency_templates)) assert.deepEqual(rec.automation_request_idempotency_templates, op.expect_automation_request_idempotency_templates);
    if (Array.isArray(op.expect_automation_request_action_types)) assert.deepEqual(rec.automation_request_action_types, op.expect_automation_request_action_types);
    if (Array.isArray(op.expect_automation_request_hashes)) assert.deepEqual(rec.automation_request_hashes, op.expect_automation_request_hashes);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_request_hashes_count')) assert.equal((rec.automation_request_hashes ?? []).length, op.expect_automation_request_hashes_count);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_request_hashes_present')) {
      const hasAllHashes = Array.isArray(rec.automation_request_hashes) && rec.automation_request_hashes.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x));
      assert.equal(hasAllHashes, op.expect_automation_request_hashes_present);
    }
    if (Array.isArray(op.expect_automation_expected_policy_versions)) assert.deepEqual(rec.automation_expected_policy_versions, op.expect_automation_expected_policy_versions);
    if (Array.isArray(op.expect_automation_expected_maintenance_modes)) assert.deepEqual(rec.automation_expected_maintenance_modes, op.expect_automation_expected_maintenance_modes);
    if (Array.isArray(op.expect_automation_expected_freeze_until)) assert.deepEqual(rec.automation_expected_freeze_until, op.expect_automation_expected_freeze_until);
    if (Array.isArray(op.expect_automation_expected_freeze_active)) assert.deepEqual(rec.automation_expected_freeze_active, op.expect_automation_expected_freeze_active);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_expected_effect_count')) assert.equal((rec.automation_expected_policy_versions ?? []).length, op.expect_automation_expected_effect_count);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_expected_effect_present')) {
      const hasExpectedEffect = Array.isArray(rec.automation_expected_policy_versions)
        && Array.isArray(rec.automation_expected_maintenance_modes)
        && Array.isArray(rec.automation_expected_freeze_until)
        && Array.isArray(rec.automation_expected_freeze_active)
        && rec.automation_expected_policy_versions.every(x => Number.isInteger(x) && x > 0)
        && rec.automation_expected_maintenance_modes.every(x => typeof x === 'boolean')
        && rec.automation_expected_freeze_until.every(x => x === null || typeof x === 'string')
        && rec.automation_expected_freeze_active.every(x => typeof x === 'boolean');
      assert.equal(hasExpectedEffect, op.expect_automation_expected_effect_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_plan_hash')) assert.equal(rec.automation_plan_hash, op.expect_automation_plan_hash);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_plan_hash_present')) {
      const hasPlanHash = typeof rec.automation_plan_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_plan_hash);
      assert.equal(hasPlanHash, op.expect_automation_plan_hash_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_policy_version_before')) {
      assert.equal(rec.automation_execution_policy_version_before, op.expect_automation_execution_policy_version_before);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_policy_version_after_expected')) {
      assert.equal(rec.automation_execution_policy_version_after_expected, op.expect_automation_execution_policy_version_after_expected);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_non_empty_action_plan')) {
      assert.equal(rec.automation_execution_non_empty_action_plan, op.expect_automation_execution_non_empty_action_plan);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_hashes_present')) {
      const hashesPresent =
        typeof rec.automation_execution_expected_effect_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_expected_effect_hash)
        && typeof rec.automation_execution_request_hash_chain === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_request_hash_chain)
        && typeof rec.automation_execution_attestation_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_attestation_hash);
      assert.equal(hashesPresent, op.expect_automation_execution_hashes_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_continuation_attestation_after')) {
      assert.equal(rec.automation_execution_continuation_attestation_after, op.expect_automation_execution_continuation_attestation_after);
    }
    if (op.expect_automation_execution_continuation_attestation_after_ref) {
      const prior = diagnosticsExportRefs[op.expect_automation_execution_continuation_attestation_after_ref];
      if (!prior) throw new Error(`missing diagnostics expect_automation_execution_continuation_attestation_after_ref export: ${op.expect_automation_execution_continuation_attestation_after_ref}`);
      assert.equal(rec.automation_execution_continuation_attestation_after, prior?.attestation?.chain_hash ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_continuation_checkpoint_after')) {
      assert.equal(rec.automation_execution_continuation_checkpoint_after, op.expect_automation_execution_continuation_checkpoint_after);
    }
    if (op.expect_automation_execution_continuation_checkpoint_after_ref) {
      const prior = diagnosticsExportRefs[op.expect_automation_execution_continuation_checkpoint_after_ref];
      if (!prior) throw new Error(`missing diagnostics expect_automation_execution_continuation_checkpoint_after_ref export: ${op.expect_automation_execution_continuation_checkpoint_after_ref}`);
      assert.equal(rec.automation_execution_continuation_checkpoint_after, prior?.checkpoint?.checkpoint_hash ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_continuation_hash_present')) {
      const continuationHashPresent = typeof rec.automation_execution_continuation_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_continuation_hash);
      assert.equal(continuationHashPresent, op.expect_automation_execution_continuation_hash_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_continuation_window_minutes')) {
      assert.equal(rec.automation_execution_continuation_window_minutes, op.expect_automation_execution_continuation_window_minutes);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_continuation_expires_at')) {
      const actual = rec.automation_execution_continuation_expires_at;
      const expected = op.expect_automation_execution_continuation_expires_at;
      const actualIso = typeof actual === 'string' ? new Date(actual).toISOString() : actual;
      const expectedIso = typeof expected === 'string' ? new Date(expected).toISOString() : expected;
      assert.equal(actualIso, expectedIso);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_receipt_steps_count')) {
      assert.equal(rec.automation_execution_receipt_steps_count, op.expect_automation_execution_receipt_steps_count);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_receipt_hash_present')) {
      const receiptHashPresent = typeof rec.automation_execution_receipt_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_receipt_hash);
      assert.equal(receiptHashPresent, op.expect_automation_execution_receipt_hash_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_journal_entry_hashes_count')) {
      assert.equal(Array.isArray(rec.automation_execution_journal_entry_hashes) ? rec.automation_execution_journal_entry_hashes.length : 0, op.expect_automation_execution_journal_entry_hashes_count);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_journal_hash_present')) {
      const journalHashPresent = typeof rec.automation_execution_journal_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_journal_hash);
      assert.equal(journalHashPresent, op.expect_automation_execution_journal_hash_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_rollback_target_policy_version')) {
      assert.equal(rec.automation_execution_rollback_target_policy_version, op.expect_automation_execution_rollback_target_policy_version);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_rollback_hash_present')) {
      const rollbackHashPresent = typeof rec.automation_execution_rollback_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_rollback_hash);
      assert.equal(rollbackHashPresent, op.expect_automation_execution_rollback_hash_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_simulation_projected_policy_version_after')) {
      assert.equal(rec.automation_execution_simulation_projected_policy_version_after, op.expect_automation_execution_simulation_projected_policy_version_after);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_simulation_risk_level')) {
      assert.equal(rec.automation_execution_simulation_risk_level, op.expect_automation_execution_simulation_risk_level);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_execution_simulation_hash_present')) {
      const simulationHashPresent = typeof rec.automation_execution_simulation_hash === 'string' && /^[a-f0-9]{64}$/.test(rec.automation_execution_simulation_hash);
      assert.equal(simulationHashPresent, op.expect_automation_execution_simulation_hash_present);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_idempotency_scope')) assert.equal(rec.automation_idempotency_scope, op.expect_automation_idempotency_scope);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_automation_max_actions_per_run')) assert.equal(rec.automation_max_actions_per_run, op.expect_automation_max_actions_per_run);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_attestation_after')) assert.equal(rec.attestation_after, op.expect_attestation_after);
    if (op.expect_attestation_after_ref) {
      const prior = diagnosticsExportRefs[op.expect_attestation_after_ref];
      if (!prior) throw new Error(`missing diagnostics expect_attestation_after_ref export: ${op.expect_attestation_after_ref}`);
      assert.equal(rec.attestation_after, prior?.attestation?.chain_hash ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_checkpoint_after')) assert.equal(rec.checkpoint_after, op.expect_checkpoint_after);
    if (op.expect_checkpoint_after_ref) {
      const prior = diagnosticsExportRefs[op.expect_checkpoint_after_ref];
      if (!prior) throw new Error(`missing diagnostics expect_checkpoint_after_ref export: ${op.expect_checkpoint_after_ref}`);
      assert.equal(rec.checkpoint_after, prior?.checkpoint?.checkpoint_hash ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_has_attestation')) assert.equal(Boolean(rec.attestation_chain_hash), op.expect_has_attestation);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_has_checkpoint')) assert.equal(Boolean(rec.checkpoint_hash), op.expect_has_checkpoint);
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

  const resignedTamperOps = {
    'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify_resigned_execution_continuation_hash_tampered': {
      field: 'continuation_hash',
      label: 'continuation_hash',
      recomputeAttestationHash: false
    },
    'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify_resigned_execution_receipt_hash_tampered': {
      field: 'receipt_hash',
      label: 'receipt_hash',
      recomputeAttestationHash: true
    },
    'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify_resigned_execution_journal_hash_tampered': {
      field: 'journal_hash',
      label: 'journal_hash',
      recomputeAttestationHash: true
    },
    'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify_resigned_execution_rollback_hash_tampered': {
      field: 'rollback_hash',
      label: 'rollback_hash',
      recomputeAttestationHash: true
    },
    'partnerProgram.vault_export.rollout_policy.diagnostics.export.verify_resigned_execution_simulation_hash_tampered': {
      field: 'simulation_hash',
      label: 'simulation_hash',
      recomputeAttestationHash: true
    }
  };

  if (Object.prototype.hasOwnProperty.call(resignedTamperOps, op.op)) {
    const payload = diagnosticsExportRefs[op.export_ref];
    if (!payload) throw new Error(`missing diagnostics export_ref: ${op.export_ref}`);

    const tampered = clone(payload);
    const execution = tampered?.automation_hints?.execution_attestation;
    if (!execution || typeof execution !== 'object') {
      throw new Error(`missing automation execution_attestation for export_ref: ${op.export_ref}`);
    }

    const cfg = resignedTamperOps[op.op];
    const originalValue = String(execution[cfg.field] ?? '');
    if (!/^[a-f0-9]{64}$/.test(originalValue)) {
      throw new Error(`execution_attestation.${cfg.label} is not a 64-hex hash for export_ref: ${op.export_ref}`);
    }

    const suffix = originalValue.endsWith('0') ? '1' : '0';
    execution[cfg.field] = `${originalValue.slice(0, Math.max(0, originalValue.length - 1))}${suffix}`;

    if (cfg.recomputeAttestationHash) {
      const sha256Canonical = value => createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
      execution.attestation_hash = sha256Canonical({
        plan_hash: tampered?.automation_hints?.plan_hash ?? null,
        policy_version_before: execution?.policy_version_before ?? 0,
        policy_version_after_expected: execution?.policy_version_after_expected ?? 0,
        non_empty_action_plan: execution?.non_empty_action_plan === true,
        expected_effect_hash: execution?.expected_effect_hash ?? null,
        request_hash_chain: execution?.request_hash_chain ?? null,
        continuation_attestation_after: execution?.continuation_attestation_after ?? null,
        continuation_checkpoint_after: execution?.continuation_checkpoint_after ?? null,
        continuation_window_minutes: execution?.continuation_window_minutes ?? 30,
        continuation_expires_at: execution?.continuation_expires_at ?? null,
        receipt_steps_count: execution?.receipt_steps_count ?? 0,
        receipt_hash: execution?.receipt_hash ?? null,
        journal_entry_hashes: execution?.journal_entry_hashes ?? [],
        journal_hash: execution?.journal_hash ?? null,
        rollback_target_policy_version: execution?.rollback_target_policy_version ?? 0,
        rollback_hash: execution?.rollback_hash ?? null,
        simulation_projected_policy_version_after: execution?.simulation_projected_policy_version_after ?? 0,
        simulation_risk_level: execution?.simulation_risk_level ?? 'low',
        simulation_hash: execution?.simulation_hash ?? null
      });
    }

    const resigned = buildSignedPartnerProgramRolloutPolicyDiagnosticsExportPayload({
      exportedAt: tampered.exported_at,
      query: tampered.query,
      policy: tampered.policy,
      overlays: tampered.overlays,
      lifecycleSignals: tampered.lifecycle_signals,
      alerts: tampered.alerts,
      recommendedActions: tampered.recommended_actions,
      runbookHooks: tampered.runbook_hooks,
      automationHints: tampered.automation_hints,
      withAttestation: Boolean(tampered.attestation),
      withCheckpoint: Boolean(tampered.checkpoint)
    });

    const verified = verifyPartnerProgramRolloutPolicyDiagnosticsExportPayload(resigned);

    const keyId = resigned.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramRolloutPolicyDiagnosticsExportPayloadWithPublicKeyPem({
          payload: resigned,
          publicKeyPem,
          keyId,
          alg: resigned.signature?.alg
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
    if (op.expect_verify_error) assert.equal(rec.verify_error, op.expect_verify_error);
    if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(rec.verify_public_ok, op.expect_verify_public_ok);
    if (op.expect_verify_public_error) assert.equal(rec.verify_public_error, op.expect_verify_public_error);

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

const checkpointState = store.state.partner_program_rollout_policy_diagnostics_export_checkpoints ?? {};
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

writeFileSync(path.join(outDir, 'rollout_diagnostics_execution_receipt_output.json'), JSON.stringify(out, null, 2));

const outHash = createHash('sha256').update(JSON.stringify(out), 'utf8').digest('hex');
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M72', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, audit_entries: rolloutPolicyAudit.length, checkpoints: checkpointKeys.length } }, null, 2));
