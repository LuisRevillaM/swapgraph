import { stableEventId } from './eventIds.mjs';

export function buildProposalCreatedEvent({ proposal, actor, occurredAt, correlationId }) {
  const type = 'proposal.created';
  const event_id = stableEventId({ type, correlationId, key: proposal.id });
  return {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      proposal
    }
  };
}

export function buildProposalExpiringEvent({ proposalId, expiresAt, actor, occurredAt, correlationId }) {
  const type = 'proposal.expiring';
  const event_id = stableEventId({ type, correlationId, key: proposalId });
  return {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      proposal_id: proposalId,
      expires_at: expiresAt
    }
  };
}
