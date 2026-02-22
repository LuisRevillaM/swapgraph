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
      liquidity_providers: {},
      liquidity_provider_personas: {},
      liquidity_provider_counter: 0,
      liquidity_provider_persona_counter: 0,
      liquidity_simulation_sessions: {},
      liquidity_simulation_events: [],
      liquidity_simulation_session_counter: 0,
      liquidity_inventory_snapshots: {},
      liquidity_inventory_assets: {},
      liquidity_inventory_reservations: {},
      liquidity_inventory_reconciliation_events: [],
      liquidity_inventory_snapshot_counter: 0,
      liquidity_inventory_reservation_counter: 0,
      liquidity_inventory_reconciliation_counter: 0,
      liquidity_listings: {},
      liquidity_decisions: {},
      liquidity_decision_counter: 0,
      liquidity_execution_modes: {},
      liquidity_execution_requests: {},
      liquidity_execution_request_counter: 0,
      liquidity_execution_export_checkpoints: {},
      liquidity_policies: {},
      liquidity_policy_decision_audit: [],
      liquidity_policy_decision_audit_counter: 0,
      liquidity_policy_export_checkpoints: {},
      liquidity_policy_daily_usage: {},
      liquidity_policy_counterparty_exposure: {},
      partner_liquidity_providers: {},
      partner_liquidity_provider_counter: 0,
      partner_liquidity_provider_rollout_policies: {},
      partner_liquidity_provider_governance_audit: [],
      partner_liquidity_provider_governance_audit_counter: 0,
      partner_liquidity_provider_rollout_export_checkpoints: {},
      platform_connections: {},
      inventory_snapshots: {},
      trust_safety_signals: {},
      trust_safety_signal_counter: 0,
      trust_safety_decisions: {},
      trust_safety_decision_counter: 0,
      trust_safety_export_checkpoints: {},
      metrics_network_health_export_checkpoints: {},
      notification_preferences: {},
      counterparty_preferences: {},
      marketplace_asset_values: {},
      marketplace_matching_runs: {},
      marketplace_matching_run_counter: 0,
      marketplace_matching_proposal_runs: {},
      commercial_policies: {},
      commercial_policy_audit: [],
      commercial_policy_export_checkpoints: {},
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
      cross_adapter_cycle_semantics: {},
      cross_adapter_cycle_receipts: {},
      cross_adapter_compensation_cases: {},
      cross_adapter_compensation_case_counter: 0,
      cross_adapter_compensation_ledger: [],
      cross_adapter_compensation_ledger_counter: 0,
      cross_adapter_dispute_linkages: [],
      cross_adapter_dispute_linkage_counter: 0,
      reliability_slo_metrics: [],
      reliability_incident_drills: [],
      reliability_replay_checks: [],
      reliability_remediation_plans: [],
      reliability_remediation_plan_counter: 0,
      staging_evidence_bundles: [],
      staging_evidence_bundle_counter: 0,
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
        liquidity_providers: {},
        liquidity_provider_personas: {},
        liquidity_provider_counter: 0,
        liquidity_provider_persona_counter: 0,
        liquidity_simulation_sessions: {},
        liquidity_simulation_events: [],
        liquidity_simulation_session_counter: 0,
        liquidity_inventory_snapshots: {},
        liquidity_inventory_assets: {},
        liquidity_inventory_reservations: {},
        liquidity_inventory_reconciliation_events: [],
        liquidity_inventory_snapshot_counter: 0,
        liquidity_inventory_reservation_counter: 0,
        liquidity_inventory_reconciliation_counter: 0,
        liquidity_listings: {},
        liquidity_decisions: {},
        liquidity_decision_counter: 0,
        liquidity_execution_modes: {},
        liquidity_execution_requests: {},
        liquidity_execution_request_counter: 0,
        liquidity_execution_export_checkpoints: {},
        liquidity_policies: {},
        liquidity_policy_decision_audit: [],
        liquidity_policy_decision_audit_counter: 0,
        liquidity_policy_export_checkpoints: {},
        liquidity_policy_daily_usage: {},
        liquidity_policy_counterparty_exposure: {},
        partner_liquidity_providers: {},
        partner_liquidity_provider_counter: 0,
        partner_liquidity_provider_rollout_policies: {},
        partner_liquidity_provider_governance_audit: [],
        partner_liquidity_provider_governance_audit_counter: 0,
        partner_liquidity_provider_rollout_export_checkpoints: {},
        platform_connections: {},
        inventory_snapshots: {},
        trust_safety_signals: {},
        trust_safety_signal_counter: 0,
        trust_safety_decisions: {},
        trust_safety_decision_counter: 0,
        trust_safety_export_checkpoints: {},
        metrics_network_health_export_checkpoints: {},
        notification_preferences: {},
        counterparty_preferences: {},
        marketplace_asset_values: {},
        marketplace_matching_runs: {},
        marketplace_matching_run_counter: 0,
        marketplace_matching_proposal_runs: {},
        commercial_policies: {},
        commercial_policy_audit: [],
        commercial_policy_export_checkpoints: {},
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
        cross_adapter_cycle_semantics: {},
        cross_adapter_cycle_receipts: {},
        cross_adapter_compensation_cases: {},
        cross_adapter_compensation_case_counter: 0,
        cross_adapter_compensation_ledger: [],
        cross_adapter_compensation_ledger_counter: 0,
        cross_adapter_dispute_linkages: [],
        cross_adapter_dispute_linkage_counter: 0,
        reliability_slo_metrics: [],
        reliability_incident_drills: [],
        reliability_replay_checks: [],
        reliability_remediation_plans: [],
        reliability_remediation_plan_counter: 0,
        staging_evidence_bundles: [],
        staging_evidence_bundle_counter: 0,
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
    this.state.liquidity_providers ||= {};
    this.state.liquidity_provider_personas ||= {};
    this.state.liquidity_provider_counter ||= 0;
    this.state.liquidity_provider_persona_counter ||= 0;
    this.state.liquidity_simulation_sessions ||= {};
    this.state.liquidity_simulation_events ||= [];
    this.state.liquidity_simulation_session_counter ||= 0;
    this.state.liquidity_inventory_snapshots ||= {};
    this.state.liquidity_inventory_assets ||= {};
    this.state.liquidity_inventory_reservations ||= {};
    this.state.liquidity_inventory_reconciliation_events ||= [];
    this.state.liquidity_inventory_snapshot_counter ||= 0;
    this.state.liquidity_inventory_reservation_counter ||= 0;
    this.state.liquidity_inventory_reconciliation_counter ||= 0;
    this.state.liquidity_listings ||= {};
    this.state.liquidity_decisions ||= {};
    this.state.liquidity_decision_counter ||= 0;
    this.state.liquidity_execution_modes ||= {};
    this.state.liquidity_execution_requests ||= {};
    this.state.liquidity_execution_request_counter ||= 0;
    this.state.liquidity_execution_export_checkpoints ||= {};
    this.state.liquidity_policies ||= {};
    this.state.liquidity_policy_decision_audit ||= [];
    this.state.liquidity_policy_decision_audit_counter ||= 0;
    this.state.liquidity_policy_export_checkpoints ||= {};
    this.state.liquidity_policy_daily_usage ||= {};
    this.state.liquidity_policy_counterparty_exposure ||= {};
    this.state.partner_liquidity_providers ||= {};
    this.state.partner_liquidity_provider_counter ||= 0;
    this.state.partner_liquidity_provider_rollout_policies ||= {};
    this.state.partner_liquidity_provider_governance_audit ||= [];
    this.state.partner_liquidity_provider_governance_audit_counter ||= 0;
    this.state.partner_liquidity_provider_rollout_export_checkpoints ||= {};
    this.state.platform_connections ||= {};
    this.state.inventory_snapshots ||= {};
    this.state.trust_safety_signals ||= {};
    this.state.trust_safety_signal_counter ||= 0;
    this.state.trust_safety_decisions ||= {};
    this.state.trust_safety_decision_counter ||= 0;
    this.state.trust_safety_export_checkpoints ||= {};
    this.state.metrics_network_health_export_checkpoints ||= {};
    this.state.notification_preferences ||= {};
    this.state.counterparty_preferences ||= {};
    this.state.marketplace_asset_values ||= {};
    this.state.marketplace_matching_runs ||= {};
    this.state.marketplace_matching_run_counter ||= 0;
    this.state.marketplace_matching_proposal_runs ||= {};
    this.state.commercial_policies ||= {};
    this.state.commercial_policy_audit ||= [];
    this.state.commercial_policy_export_checkpoints ||= {};
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
    this.state.cross_adapter_cycle_semantics ||= {};
    this.state.cross_adapter_cycle_receipts ||= {};
    this.state.cross_adapter_compensation_cases ||= {};
    this.state.cross_adapter_compensation_case_counter ||= 0;
    this.state.cross_adapter_compensation_ledger ||= [];
    this.state.cross_adapter_compensation_ledger_counter ||= 0;
    this.state.cross_adapter_dispute_linkages ||= [];
    this.state.cross_adapter_dispute_linkage_counter ||= 0;
    this.state.reliability_slo_metrics ||= [];
    this.state.reliability_incident_drills ||= [];
    this.state.reliability_replay_checks ||= [];
    this.state.reliability_remediation_plans ||= [];
    this.state.reliability_remediation_plan_counter ||= 0;
    this.state.staging_evidence_bundles ||= [];
    this.state.staging_evidence_bundle_counter ||= 0;
    this.state.oauth_clients ||= {};
    this.state.oauth_tokens ||= {};
  }

  save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const pretty = JSON.stringify(canonicalize(this.state), null, 2);
    writeFileSync(this.filePath, pretty);
  }
}
