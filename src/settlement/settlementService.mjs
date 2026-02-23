import crypto from 'node:crypto';

import { commitIdForProposalId } from '../commit/commitIds.mjs';
import { stableEventId } from '../delivery/eventIds.mjs';
import { signReceipt } from '../crypto/receiptSigning.mjs';
import { signEventEnvelope } from '../crypto/eventSigning.mjs';

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function assetKey(asset) {
  return `${asset?.platform ?? ''}:${asset?.asset_id ?? ''}`;
}

function ensureVaultState(store) {
  store.state.vault_holdings ||= {};
  store.state.vault_events ||= [];
}

function applyVaultBindingsToTimeline({ store, proposal, timeline, vaultBindings, occurredAt }) {
  if (!Array.isArray(vaultBindings) || vaultBindings.length === 0) {
    return { ok: true, applied_count: 0 };
  }

  ensureVaultState(store);

  const legsByIntent = new Map((timeline.legs ?? []).map(leg => [leg.intent_id, leg]));
  const seenIntentIds = new Set();
  const seenHoldingIds = new Set();
  const planned = [];

  for (const binding of vaultBindings) {
    const intentId = binding?.intent_id;
    const holdingId = binding?.holding_id;
    const reservationId = binding?.reservation_id;

    if (!intentId || !holdingId || !reservationId) {
      return {
        ok: false,
        error: {
          code: 'SCHEMA_INVALID',
          message: 'vault binding payload is invalid',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_binding_invalid',
            binding
          }
        }
      };
    }

    const leg = legsByIntent.get(intentId);
    if (!leg) {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'vault binding intent is not in cycle',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_binding_intent_not_in_cycle',
            intent_id: intentId
          }
        }
      };
    }

    if (seenIntentIds.has(intentId)) {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'duplicate vault binding for intent',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_binding_duplicate_intent',
            intent_id: intentId
          }
        }
      };
    }

    if (seenHoldingIds.has(holdingId)) {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'duplicate vault binding for holding',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_binding_duplicate_holding',
            holding_id: holdingId
          }
        }
      };
    }

    const holding = store.state.vault_holdings[holdingId] ?? null;
    if (!holding) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'vault holding not found',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_holding_not_found',
            intent_id: intentId,
            holding_id: holdingId
          }
        }
      };
    }

    if (holding.status !== 'reserved') {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'vault holding is not reserved',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_holding_not_reserved',
            intent_id: intentId,
            holding_id: holdingId,
            status: holding.status
          }
        }
      };
    }

    if (holding.reservation_id !== reservationId) {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'vault reservation does not match holding reservation',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_reservation_mismatch',
            intent_id: intentId,
            holding_id: holdingId,
            expected_reservation_id: holding.reservation_id,
            reservation_id: reservationId
          }
        }
      };
    }

    if (actorKey(holding.owner_actor) !== actorKey(leg.from_actor)) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'vault holding owner does not match cycle leg actor',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_owner_mismatch',
            intent_id: intentId,
            holding_id: holdingId,
            owner_actor: holding.owner_actor,
            expected_actor: leg.from_actor
          }
        }
      };
    }

    const legAssetKeys = new Set((leg.assets ?? []).map(assetKey));
    if (!legAssetKeys.has(assetKey(holding.asset))) {
      return {
        ok: false,
        error: {
          code: 'CONSTRAINT_VIOLATION',
          message: 'vault holding asset does not match leg assets',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_binding_asset_mismatch',
            intent_id: intentId,
            holding_id: holdingId,
            holding_asset: holding.asset,
            leg_assets: leg.assets
          }
        }
      };
    }

    const existingSettlementCycleId = holding.settlement_cycle_id ?? null;
    if (existingSettlementCycleId && existingSettlementCycleId !== proposal.id) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'vault holding is already bound to another settlement cycle',
          details: {
            cycle_id: proposal.id,
            reason_code: 'vault_holding_in_settlement',
            intent_id: intentId,
            holding_id: holdingId,
            holding_cycle_id: existingSettlementCycleId
          }
        }
      };
    }

    seenIntentIds.add(intentId);
    seenHoldingIds.add(holdingId);
    planned.push({ binding, leg, holding });
  }

  for (const { binding, leg, holding } of planned) {
    leg.status = 'deposited';
    leg.deposit_mode = 'vault';
    leg.deposit_ref = `vault:${holding.holding_id}:${binding.reservation_id}`;
    leg.deposited_at = occurredAt;
    leg.vault_holding_id = holding.holding_id;
    leg.vault_reservation_id = binding.reservation_id;

    holding.settlement_cycle_id = proposal.id;
    holding.updated_at = occurredAt;
  }

  return { ok: true, applied_count: planned.length };
}

function settleVaultBindingsForTerminalState({ store, timeline, finalState, occurredAt }) {
  if (!timeline?.cycle_id) return;
  if (!['completed', 'failed'].includes(finalState)) return;

  ensureVaultState(store);

  for (const leg of timeline.legs ?? []) {
    const holdingId = leg?.vault_holding_id;
    const reservationId = leg?.vault_reservation_id;
    if (!holdingId || !reservationId) continue;

    const holding = store.state.vault_holdings[holdingId] ?? null;
    if (!holding) continue;

    if ((holding.settlement_cycle_id ?? null) && holding.settlement_cycle_id !== timeline.cycle_id) continue;
    if ((holding.reservation_id ?? null) !== reservationId) continue;

    if (finalState === 'completed') {
      holding.status = 'withdrawn';
      holding.withdrawn_at = occurredAt;
    } else if (finalState === 'failed') {
      holding.status = 'available';
    }

    holding.reservation_id = null;
    holding.settlement_cycle_id = null;
    holding.updated_at = occurredAt;
  }
}

function stableReceiptId({ cycleId, finalState }) {
  const h = crypto.createHash('sha256').update(`${cycleId}|${finalState}`).digest('hex').slice(0, 12);
  return `receipt_${h}`;
}

function buildCycleStateChangedEvent({ cycleId, fromState, toState, reasonCode, actor, occurredAt }) {
  const type = 'cycle.state_changed';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: `${fromState}->${toState}` });
  const payload = {
    cycle_id: cycleId,
    from_state: fromState,
    to_state: toState
  };
  if (reasonCode) payload.reason_code = reasonCode;

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

function buildSettlementDepositRequiredEvent({ cycleId, depositDeadlineAt, actor, occurredAt }) {
  const type = 'settlement.deposit_required';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: `deposit_required|${depositDeadlineAt}` });

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      cycle_id: cycleId,
      deposit_deadline_at: depositDeadlineAt
    }
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

function buildSettlementDepositConfirmedEvent({ cycleId, intentId, depositRef, actor, occurredAt }) {
  const type = 'settlement.deposit_confirmed';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: `${intentId}|${depositRef}` });

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      cycle_id: cycleId,
      intent_id: intentId,
      deposit_ref: depositRef
    }
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

function buildSettlementExecutingEvent({ cycleId, actor, occurredAt }) {
  const type = 'settlement.executing';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: 'executing' });

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      cycle_id: cycleId
    }
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

function buildIntentUnreservedEvent({ intentId, cycleId, reason, actor, occurredAt }) {
  const type = 'intent.unreserved';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: `${intentId}` });

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      intent_id: intentId,
      cycle_id: cycleId,
      reason
    }
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

function buildReceiptCreatedEvent({ receipt, actor, occurredAt }) {
  const type = 'receipt.created';
  const correlationId = `corr_${receipt.cycle_id}`;
  const event_id = stableEventId({ type, correlationId, key: `${receipt.id}` });

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      receipt
    }
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

function buildLegs({ proposal, depositDeadlineAt }) {
  const n = proposal.participants.length;
  const legs = [];
  for (let i = 0; i < n; i++) {
    const from = proposal.participants[i];
    const to = proposal.participants[(i - 1 + n) % n];
    legs.push({
      leg_id: `leg_${proposal.id}_${i}`,
      intent_id: from.intent_id,
      from_actor: from.actor,
      to_actor: to.actor,
      assets: from.give,
      status: 'pending',
      deposit_deadline_at: depositDeadlineAt
    });
  }
  return legs;
}

export class SettlementService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
  }

  start({ actor, proposal, occurredAt, depositDeadlineAt, vaultBindings }) {
    if (!depositDeadlineAt) throw new Error('depositDeadlineAt is required');

    const commitId = commitIdForProposalId(proposal.id);
    const commit = this.store.state.commits[commitId];
    if (!commit) return { ok: false, error: { code: 'NOT_FOUND', message: 'commit not found', details: { commit_id: commitId } } };
    if (commit.phase !== 'ready') {
      return { ok: false, error: { code: 'CONFLICT', message: 'commit is not ready for settlement', details: { commit_id: commitId, phase: commit.phase } } };
    }

    // Record partner scoping for multi-tenant read access.
    this.store.state.tenancy ||= {};
    this.store.state.tenancy.cycles ||= {};
    const existingScope = this.store.state.tenancy.cycles[proposal.id];
    if (existingScope?.partner_id && existingScope.partner_id !== actor.id) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'cycle is owned by a different partner',
          details: { cycle_id: proposal.id, partner_id: actor.id, cycle_partner_id: existingScope.partner_id }
        }
      };
    }

    const existing = this.store.state.timelines[proposal.id];
    if (existing) {
      // idempotent: allow re-start if already started.
      return { ok: true, timeline: existing, replayed: true };
    }
    this.store.state.tenancy.cycles[proposal.id] = { partner_id: actor.id };

    const timeline = {
      cycle_id: proposal.id,
      state: 'escrow.pending',
      legs: buildLegs({ proposal, depositDeadlineAt }),
      updated_at: occurredAt
    };

    const vaultBindingResult = applyVaultBindingsToTimeline({
      store: this.store,
      proposal,
      timeline,
      vaultBindings,
      occurredAt
    });
    if (!vaultBindingResult.ok) return vaultBindingResult;

    const allDeposited = (timeline.legs ?? []).every(leg => leg.status === 'deposited');
    if (allDeposited) {
      timeline.state = 'escrow.ready';
      timeline.updated_at = occurredAt;
    }

    this.store.state.timelines[proposal.id] = timeline;

    // accepted -> escrow.pending
    this.store.state.events.push(buildCycleStateChangedEvent({
      cycleId: proposal.id,
      fromState: 'accepted',
      toState: 'escrow.pending',
      actor,
      occurredAt
    }));

    if (!allDeposited) {
      this.store.state.events.push(buildSettlementDepositRequiredEvent({
        cycleId: proposal.id,
        depositDeadlineAt,
        actor,
        occurredAt
      }));
    } else {
      this.store.state.events.push(buildCycleStateChangedEvent({
        cycleId: proposal.id,
        fromState: 'escrow.pending',
        toState: 'escrow.ready',
        actor,
        occurredAt
      }));
    }

    return { ok: true, timeline, replayed: false };
  }

  confirmDeposit({ actor, cycleId, depositRef, occurredAt }) {
    if (!depositRef) throw new Error('depositRef is required');

    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) return { ok: false, error: { code: 'NOT_FOUND', message: 'timeline not found', details: { cycle_id: cycleId } } };

    const leg = (timeline.legs ?? []).find(l => actorKey(l.from_actor) === actorKey(actor));
    if (!leg) {
      return { ok: false, error: { code: 'CONSTRAINT_VIOLATION', message: 'actor is not a depositor in this cycle', details: { cycle_id: cycleId, actor } } };
    }

    if (leg.deposit_mode === 'vault') {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'vault-backed leg does not accept manual deposit confirmation',
          details: {
            cycle_id: cycleId,
            intent_id: leg.intent_id,
            reason_code: 'vault_backed_leg',
            vault_holding_id: leg.vault_holding_id,
            vault_reservation_id: leg.vault_reservation_id
          }
        }
      };
    }

    if (leg.status === 'pending') {
      leg.status = 'deposited';
      leg.deposit_ref = depositRef;
      leg.deposited_at = occurredAt;
      timeline.updated_at = occurredAt;

      this.store.state.events.push(buildSettlementDepositConfirmedEvent({
        cycleId,
        intentId: leg.intent_id,
        depositRef,
        actor,
        occurredAt
      }));
    } else if (leg.status === 'deposited') {
      if (leg.deposit_ref !== depositRef) {
        return { ok: false, error: { code: 'CONFLICT', message: 'deposit already confirmed with a different reference', details: { cycle_id: cycleId, actor, existing_ref: leg.deposit_ref, new_ref: depositRef } } };
      }
      return { ok: true, timeline, replayed: true };
    } else {
      return { ok: false, error: { code: 'CONFLICT', message: 'cannot confirm deposit in this state', details: { cycle_id: cycleId, actor, leg_status: leg.status, timeline_state: timeline.state } } };
    }

    const allDeposited = (timeline.legs ?? []).every(l => l.status === 'deposited');
    if (allDeposited && timeline.state === 'escrow.pending') {
      timeline.state = 'escrow.ready';
      timeline.updated_at = occurredAt;
      this.store.state.events.push(buildCycleStateChangedEvent({
        cycleId,
        fromState: 'escrow.pending',
        toState: 'escrow.ready',
        actor,
        occurredAt
      }));
    }

    return { ok: true, timeline, replayed: false };
  }

  beginExecution({ actor, cycleId, occurredAt }) {
    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) return { ok: false, error: { code: 'NOT_FOUND', message: 'timeline not found', details: { cycle_id: cycleId } } };

    if (timeline.state !== 'escrow.ready') {
      return { ok: false, error: { code: 'CONFLICT', message: 'cycle is not escrow.ready', details: { cycle_id: cycleId, state: timeline.state } } };
    }

    timeline.state = 'executing';
    timeline.updated_at = occurredAt;

    this.store.state.events.push(buildCycleStateChangedEvent({
      cycleId,
      fromState: 'escrow.ready',
      toState: 'executing',
      actor,
      occurredAt
    }));

    this.store.state.events.push(buildSettlementExecutingEvent({ cycleId, actor, occurredAt }));

    return { ok: true, timeline };
  }

  complete({ actor, cycleId, occurredAt }) {
    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) return { ok: false, error: { code: 'NOT_FOUND', message: 'timeline not found', details: { cycle_id: cycleId } } };

    if (timeline.state !== 'executing') {
      return { ok: false, error: { code: 'CONFLICT', message: 'cycle is not executing', details: { cycle_id: cycleId, state: timeline.state } } };
    }

    for (const leg of timeline.legs ?? []) {
      if (leg.status !== 'deposited') {
        return { ok: false, error: { code: 'CONFLICT', message: 'cannot complete; not all legs deposited', details: { cycle_id: cycleId, leg_id: leg.leg_id, leg_status: leg.status } } };
      }
      leg.status = 'released';
      leg.release_ref = leg.release_ref ?? `rel_${cycleId}_${leg.intent_id}`;
      leg.released_at = occurredAt;
    }

    timeline.state = 'completed';
    timeline.updated_at = occurredAt;

    this.store.state.events.push(buildCycleStateChangedEvent({
      cycleId,
      fromState: 'executing',
      toState: 'completed',
      actor,
      occurredAt
    }));

    // Terminal state: release reservations.
    const intentIds = (timeline.legs ?? []).map(l => l.intent_id);
    for (const intentId of intentIds) {
      if (this.store.state.reservations[intentId]) {
        delete this.store.state.reservations[intentId];
        this.store.state.events.push(buildIntentUnreservedEvent({ intentId, cycleId, reason: 'settled', actor, occurredAt }));
      }
    }

    settleVaultBindingsForTerminalState({
      store: this.store,
      timeline,
      finalState: 'completed',
      occurredAt
    });

    const assetIds = (timeline.legs ?? [])
      .flatMap(l => (l.assets ?? []).map(a => a.asset_id))
      .filter(Boolean);
    assetIds.sort();

    const unsignedReceipt = {
      id: stableReceiptId({ cycleId, finalState: 'completed' }),
      cycle_id: cycleId,
      final_state: 'completed',
      intent_ids: intentIds,
      asset_ids: Array.from(new Set(assetIds)),
      created_at: occurredAt
    };

    const receipt = { ...unsignedReceipt, signature: signReceipt(unsignedReceipt) };

    this.store.state.receipts[cycleId] = receipt;
    this.store.state.events.push(buildReceiptCreatedEvent({ receipt, actor, occurredAt }));

    return { ok: true, timeline, receipt };
  }

  expireDepositWindow({ actor, cycleId, nowIso }) {
    const timeline = this.store.state.timelines[cycleId];
    if (!timeline) return { ok: false, error: { code: 'NOT_FOUND', message: 'timeline not found', details: { cycle_id: cycleId } } };

    if (timeline.state !== 'escrow.pending') {
      return { ok: true, no_op: true, details: { cycle_id: cycleId, state: timeline.state } };
    }

    const deadline = (timeline.legs ?? [])[0]?.deposit_deadline_at;
    if (!deadline) throw new Error('deposit_deadline_at missing in timeline legs');

    const nowMs = Date.parse(nowIso);
    const dlMs = Date.parse(deadline);
    if (!Number.isFinite(nowMs) || !Number.isFinite(dlMs)) throw new Error('invalid ISO timestamp');

    const allDeposited = (timeline.legs ?? []).every(l => l.status === 'deposited');
    if (allDeposited) {
      return { ok: true, no_op: true, details: { cycle_id: cycleId, reason: 'all_deposited' } };
    }

    if (nowMs <= dlMs) {
      return { ok: true, no_op: true, details: { cycle_id: cycleId, reason: 'not_expired' } };
    }

    // Expired + missing deposits => unwind/refund.
    for (const leg of timeline.legs ?? []) {
      if (leg.status === 'deposited') {
        leg.status = 'refunded';
        leg.refund_ref = leg.refund_ref ?? `refund_${cycleId}_${leg.intent_id}`;
        leg.refunded_at = nowIso;
      }
    }

    timeline.state = 'failed';
    timeline.updated_at = nowIso;

    this.store.state.events.push(buildCycleStateChangedEvent({
      cycleId,
      fromState: 'escrow.pending',
      toState: 'failed',
      reasonCode: 'deposit_timeout',
      actor,
      occurredAt: nowIso
    }));

    // Terminal state: release reservations.
    const intentIds = (timeline.legs ?? []).map(l => l.intent_id);
    for (const intentId of intentIds) {
      if (this.store.state.reservations[intentId]) {
        delete this.store.state.reservations[intentId];
        this.store.state.events.push(buildIntentUnreservedEvent({ intentId, cycleId, reason: 'failed', actor, occurredAt: nowIso }));
      }
    }

    settleVaultBindingsForTerminalState({
      store: this.store,
      timeline,
      finalState: 'failed',
      occurredAt: nowIso
    });

    const assetIds = (timeline.legs ?? [])
      .flatMap(l => (l.assets ?? []).map(a => a.asset_id))
      .filter(Boolean);
    assetIds.sort();

    const unsignedReceipt = {
      id: stableReceiptId({ cycleId, finalState: 'failed' }),
      cycle_id: cycleId,
      final_state: 'failed',
      intent_ids: intentIds,
      asset_ids: Array.from(new Set(assetIds)),
      created_at: nowIso,
      transparency: { reason_code: 'deposit_timeout' }
    };

    const receipt = { ...unsignedReceipt, signature: signReceipt(unsignedReceipt) };

    this.store.state.receipts[cycleId] = receipt;
    this.store.state.events.push(buildReceiptCreatedEvent({ receipt, actor, occurredAt: nowIso }));

    return { ok: true, timeline, receipt };
  }
}
