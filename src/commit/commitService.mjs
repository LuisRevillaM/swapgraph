import { commitIdForProposalId } from './commitIds.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { stableEventId } from '../delivery/eventIds.mjs';

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function correlationIdForCycleId(cycleId) {
  return `corr_${cycleId}`;
}

// Note: commit timestamps are provided by the caller (fixtures-first, deterministic verification).

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForCommitId(commitId) {
  return `corr_${commitId}`;
}

function participantKey(p) {
  return actorKey(p.actor);
}

function buildIntentReservedEvent({ intentId, cycleId, reservedUntil, actor, occurredAt }) {
  const type = 'intent.reserved';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: `${intentId}` });
  return {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      intent_id: intentId,
      cycle_id: cycleId,
      reserved_until: reservedUntil
    }
  };
}

function buildIntentUnreservedEvent({ intentId, cycleId, reason, actor, occurredAt }) {
  const type = 'intent.unreserved';
  const correlationId = `corr_${cycleId}`;
  const event_id = stableEventId({ type, correlationId, key: `${intentId}` });
  return {
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
  return {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload
  };
}

export class CommitService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const h = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === h) {
        return { replayed: true, result: existing.result };
      }
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlationId,
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'Idempotency key reused with a different payload',
            { scope_key: scopeKey, original_hash: existing.payload_hash, new_hash: h }
          )
        }
      };
    }

    const result = handler();
    const snapshot = JSON.parse(JSON.stringify(result));
    this.store.state.idempotency[scopeKey] = { payload_hash: h, result: snapshot };
    return { replayed: false, result: snapshot };
  }

  /**
   * proposal: CycleProposal
   */
  _getOrCreateCommit({ proposal, occurredAt }) {
    const commitId = commitIdForProposalId(proposal.id);
    const existing = this.store.state.commits[commitId];
    if (existing) return existing;

    const participants = proposal.participants.map(p => ({
      actor: p.actor,
      status: 'pending'
    }));

    const commit = {
      id: commitId,
      cycle_id: proposal.id,
      phase: 'accept',
      participants,
      created_at: occurredAt,
      updated_at: occurredAt
    };

    this.store.state.commits[commitId] = commit;
    return commit;
  }

  _reserveIntents({ commitId, proposal, actorForEvent, occurredAt }) {
    const cycleId = proposal.id;
    const reservedUntil = proposal.expires_at;
    const intentIds = proposal.participants.map(p => p.intent_id);

    // Check conflicts first.
    for (const iid of intentIds) {
      const existing = this.store.state.reservations[iid];
      if (existing && existing.commit_id !== commitId) {
        return {
          ok: false,
          body: errorResponse(correlationIdForCycleId(cycleId), 'RESERVATION_CONFLICT', 'intent already reserved', { intent_id: iid, existing_commit_id: existing.commit_id })
        };
      }
    }

    // Reserve.
    for (const iid of intentIds) {
      this.store.state.reservations[iid] = { commit_id: commitId, cycle_id: cycleId, reserved_until: reservedUntil };
      this.store.state.events.push(buildIntentReservedEvent({
        intentId: iid,
        cycleId,
        reservedUntil,
        actor: actorForEvent,
        occurredAt
      }));
    }

    return { ok: true };
  }

  _unreserveIntents({ commitId, proposal, actorForEvent, occurredAt, reason }) {
    const cycleId = proposal.id;
    const intentIds = proposal.participants.map(p => p.intent_id);

    for (const iid of intentIds) {
      const existing = this.store.state.reservations[iid];
      if (existing?.commit_id === commitId) {
        delete this.store.state.reservations[iid];
        this.store.state.events.push(buildIntentUnreservedEvent({
          intentId: iid,
          cycleId,
          reason,
          actor: actorForEvent,
          occurredAt
        }));
      }
    }
  }

  accept({ actor, idempotencyKey, proposal, requestBody, occurredAt }) {
    return this._withIdempotency({
      actor,
      operationId: 'cycleProposals.accept',
      idempotencyKey,
      requestBody,
      correlationId: correlationIdForCycleId(proposal.id),
      handler: () => {
        if (!occurredAt) throw new Error('occurredAt is required');

        if (requestBody.proposal_id !== proposal.id) {
          return {
            ok: false,
            body: errorResponse(
              correlationIdForCycleId(proposal.id),
              'CONSTRAINT_VIOLATION',
              'proposal_id must match path id',
              { proposal_id: requestBody.proposal_id, path_id: proposal.id }
            )
          };
        }

        // Ensure actor is a participant.
        const isParticipant = proposal.participants.some(p => participantKey(p) === actorKey(actor));
        if (!isParticipant) {
          return {
            ok: false,
            body: errorResponse(correlationIdForCycleId(proposal.id), 'FORBIDDEN', 'actor not in proposal', { proposal_id: proposal.id })
          };
        }

        const commitId = commitIdForProposalId(proposal.id);
        let commit = this.store.state.commits[commitId];

        if (!commit) {
          // Reserve all intents before creating a commit record.
          const r = this._reserveIntents({ commitId, proposal, actorForEvent: actor, occurredAt });
          if (!r.ok) return r;
          commit = this._getOrCreateCommit({ proposal, occurredAt });
        }

        if (commit.phase === 'cancelled') {
          return {
            ok: false,
            body: errorResponse(correlationIdForCycleId(proposal.id), 'CONFLICT', 'commit is cancelled', { commit_id: commit.id })
          };
        }

        // Mark this participant accepted.
        for (const p of commit.participants) {
          if (participantKey(p) === actorKey(actor)) {
            p.status = 'accepted';
            p.commit_token = p.commit_token ?? `tok_${commit.id}_${actorKey(actor)}`;
          }
        }

        // If all accepted → ready.
        const allAccepted = commit.participants.every(p => p.status === 'accepted');
        if (allAccepted && commit.phase !== 'ready') {
          commit.phase = 'ready';
          this.store.state.events.push(buildCycleStateChangedEvent({
            cycleId: proposal.id,
            fromState: 'proposed',
            toState: 'accepted',
            actor,
            occurredAt
          }));
        }

        commit.updated_at = occurredAt;
        return { ok: true, body: { correlation_id: correlationIdForCycleId(proposal.id), commit } };
      }
    });
  }

  decline({ actor, idempotencyKey, proposal, requestBody, occurredAt }) {
    return this._withIdempotency({
      actor,
      operationId: 'cycleProposals.decline',
      idempotencyKey,
      requestBody,
      correlationId: correlationIdForCycleId(proposal.id),
      handler: () => {
        if (!occurredAt) throw new Error('occurredAt is required');

        if (requestBody.proposal_id !== proposal.id) {
          return {
            ok: false,
            body: errorResponse(
              correlationIdForCycleId(proposal.id),
              'CONSTRAINT_VIOLATION',
              'proposal_id must match path id',
              { proposal_id: requestBody.proposal_id, path_id: proposal.id }
            )
          };
        }

        const commitId = commitIdForProposalId(proposal.id);
        const commit = this.store.state.commits[commitId];
        if (!commit) {
          // Decline before any accept => no reservations exist; return a cancelled commit for auditability.
          const created = this._getOrCreateCommit({ proposal, occurredAt });
          for (const p of created.participants) {
            if (participantKey(p) === actorKey(actor)) p.status = 'declined';
          }
          created.phase = 'cancelled';
          created.updated_at = occurredAt;
          return { ok: true, body: { correlation_id: correlationIdForCycleId(proposal.id), commit: created } };
        }

        const isParticipant = commit.participants.some(p => participantKey(p) === actorKey(actor));
        if (!isParticipant) {
          return {
            ok: false,
            body: errorResponse(correlationIdForCycleId(proposal.id), 'FORBIDDEN', 'actor not in proposal', { proposal_id: proposal.id })
          };
        }

        for (const p of commit.participants) {
          if (participantKey(p) === actorKey(actor)) {
            p.status = 'declined';
          }
        }

        commit.phase = 'cancelled';
        commit.updated_at = occurredAt;

        // Release reservations.
        this._unreserveIntents({ commitId: commit.id, proposal, actorForEvent: actor, occurredAt, reason: 'declined' });

        return { ok: true, body: { correlation_id: correlationIdForCycleId(proposal.id), commit } };
      }
    });
  }

  expireAcceptPhase({ proposals, nowIso, actor }) {
    if (!nowIso) throw new Error('nowIso is required');
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) throw new Error('nowIso must be ISO date-time');

    const expired = [];

    for (const proposal of proposals ?? []) {
      const expMs = Date.parse(proposal.expires_at);
      if (!Number.isFinite(expMs)) throw new Error(`invalid proposal.expires_at for ${proposal.id}`);
      if (nowMs <= expMs) continue;

      const commitId = commitIdForProposalId(proposal.id);
      const commit = this.store.state.commits[commitId];
      if (!commit) continue;
      if (commit.phase !== 'accept') continue; // accept window only

      commit.phase = 'cancelled';
      commit.updated_at = nowIso;

      this._unreserveIntents({ commitId: commit.id, proposal, actorForEvent: actor, occurredAt: nowIso, reason: 'expired' });

      this.store.state.events.push(buildCycleStateChangedEvent({
        cycleId: proposal.id,
        fromState: 'proposed',
        toState: 'failed',
        reasonCode: 'proposal_expired',
        actor,
        occurredAt: nowIso
      }));

      expired.push(commitId);
    }

    return { ok: true, expired_commit_ids: expired };
  }

  get({ actor, commitId }) {
    const commit = this.store.state.commits[commitId];
    if (!commit) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCommitId(commitId), 'NOT_FOUND', 'commit not found', { commit_id: commitId })
      };
    }

    // v1: only participants can view.
    const allowed = commit.participants.some(p => participantKey(p) === actorKey(actor));
    if (!allowed) {
      return {
        ok: false,
        body: errorResponse(correlationIdForCycleId(commit.cycle_id), 'FORBIDDEN', 'actor cannot access this commit', { commit_id: commitId })
      };
    }

    return { ok: true, body: { correlation_id: correlationIdForCycleId(commit.cycle_id), commit } };
  }
}
