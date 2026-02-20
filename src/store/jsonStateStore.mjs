import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalize } from '../util/canonicalJson.mjs';

export class JsonStateStore {
  /**
   * @param {{ filePath: string }} opts
   */
  constructor({ filePath }) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = filePath;
    this.state = {
      intents: {},
      proposals: {},
      commits: {},
      reservations: {},
      timelines: {},
      receipts: {},
      delegations: {},
      tenancy: { cycles: {}, proposals: {} },
      events: [],
      idempotency: {},
      policy_spend_daily: {},
      policy_audit: [],
      policy_consent_replay: {},
      policy_audit_export_checkpoints: {},
      settlement_vault_export_checkpoints: {},
      partner_program: {},
      partner_program_usage: {},
      partner_program_rollout_policy: {},
      partner_program_rollout_policy_audit: [],
      partner_program_rollout_policy_export_checkpoints: {},
      partner_program_commercial_usage_ledger: [],
      partner_program_sla_policy: {},
      partner_program_sla_breach_events: [],
      partner_program_webhook_delivery_attempts: [],
      partner_program_webhook_retry_policies: {},
      partner_program_risk_tier_policy: {},
      partner_program_risk_tier_usage_counters: {},
      partner_program_disputes: [],
      steam_tier1_adapter_contract: {},
      steam_tier1_preflight_history: [],
      steam_tier1_live_deposit_per_swap_proofs: [],
      steam_tier1_live_vault_proofs: [],
      transparency_log_publications: [],
      transparency_log_export_checkpoints: {},
      transparency_log_publication_counter: 0,
      transparency_log_entry_counter: 0,
      inclusion_proof_linkages: [],
      inclusion_proof_export_checkpoints: {},
      inclusion_proof_linkage_counter: 0,
      tier2_adapter_capabilities: {},
      tier2_adapter_preflight_history: [],
      oauth_clients: {},
      oauth_tokens: {}
    };
  }

  load() {
    if (!existsSync(this.filePath)) {
      this.state = {
        intents: {},
        proposals: {},
        commits: {},
        reservations: {},
        timelines: {},
        receipts: {},
        delegations: {},
        tenancy: { cycles: {}, proposals: {} },
        events: [],
        idempotency: {},
        policy_spend_daily: {},
        policy_audit: [],
        policy_consent_replay: {},
        policy_audit_export_checkpoints: {},
        settlement_vault_export_checkpoints: {},
        partner_program: {},
        partner_program_usage: {},
        partner_program_rollout_policy: {},
        partner_program_rollout_policy_audit: [],
        partner_program_rollout_policy_export_checkpoints: {},
        partner_program_commercial_usage_ledger: [],
        partner_program_sla_policy: {},
        partner_program_sla_breach_events: [],
        partner_program_webhook_delivery_attempts: [],
        partner_program_webhook_retry_policies: {},
        partner_program_risk_tier_policy: {},
        partner_program_risk_tier_usage_counters: {},
        partner_program_disputes: [],
        steam_tier1_adapter_contract: {},
        steam_tier1_preflight_history: [],
        steam_tier1_live_deposit_per_swap_proofs: [],
        steam_tier1_live_vault_proofs: [],
        transparency_log_publications: [],
        transparency_log_export_checkpoints: {},
        transparency_log_publication_counter: 0,
        transparency_log_entry_counter: 0,
        inclusion_proof_linkages: [],
        inclusion_proof_export_checkpoints: {},
        inclusion_proof_linkage_counter: 0,
        tier2_adapter_capabilities: {},
        tier2_adapter_preflight_history: [],
        oauth_clients: {},
        oauth_tokens: {}
      };
      return;
    }
    const raw = readFileSync(this.filePath, 'utf8');
    this.state = JSON.parse(raw);
    this.state.intents ||= {};
    this.state.proposals ||= {};
    this.state.commits ||= {};
    this.state.reservations ||= {};
    this.state.timelines ||= {};
    this.state.receipts ||= {};
    this.state.delegations ||= {};
    this.state.tenancy ||= {};
    this.state.tenancy.cycles ||= {};
    this.state.tenancy.proposals ||= {};
    this.state.events ||= [];
    this.state.idempotency ||= {};
    this.state.policy_spend_daily ||= {};
    this.state.policy_audit ||= [];
    this.state.policy_consent_replay ||= {};
    this.state.policy_audit_export_checkpoints ||= {};
    this.state.settlement_vault_export_checkpoints ||= {};
    this.state.partner_program ||= {};
    this.state.partner_program_usage ||= {};
    this.state.partner_program_rollout_policy ||= {};
    this.state.partner_program_rollout_policy_audit ||= [];
    this.state.partner_program_rollout_policy_export_checkpoints ||= {};
    this.state.partner_program_commercial_usage_ledger ||= [];
    this.state.partner_program_sla_policy ||= {};
    this.state.partner_program_sla_breach_events ||= [];
    this.state.partner_program_webhook_delivery_attempts ||= [];
    this.state.partner_program_webhook_retry_policies ||= {};
    this.state.partner_program_risk_tier_policy ||= {};
    this.state.partner_program_risk_tier_usage_counters ||= {};
    this.state.partner_program_disputes ||= [];
    this.state.steam_tier1_adapter_contract ||= {};
    this.state.steam_tier1_preflight_history ||= [];
    this.state.steam_tier1_live_deposit_per_swap_proofs ||= [];
    this.state.steam_tier1_live_vault_proofs ||= [];
    this.state.transparency_log_publications ||= [];
    this.state.transparency_log_export_checkpoints ||= {};
    this.state.transparency_log_publication_counter ||= 0;
    this.state.transparency_log_entry_counter ||= 0;
    this.state.inclusion_proof_linkages ||= [];
    this.state.inclusion_proof_export_checkpoints ||= {};
    this.state.inclusion_proof_linkage_counter ||= 0;
    this.state.tier2_adapter_capabilities ||= {};
    this.state.tier2_adapter_preflight_history ||= [];
    this.state.oauth_clients ||= {};
    this.state.oauth_tokens ||= {};
  }

  save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const pretty = JSON.stringify(canonicalize(this.state), null, 2);
    writeFileSync(this.filePath, pretty);
  }
}
