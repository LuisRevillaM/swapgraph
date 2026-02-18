import { stableEventId } from './eventIds.mjs';
import { signEventEnvelope } from '../crypto/eventSigning.mjs';

export function buildProposalCreatedEvent({ proposal, actor, occurredAt, correlationId }) {
  const type = 'proposal.created';
  const event_id = stableEventId({ type, correlationId, key: proposal.id });

  const envelope = {
    event_id,
    type,
    occurred_at: occurredAt,
    correlation_id: correlationId,
    actor,
    payload: {
      proposal
    }
  };

  return { ...envelope, signature: signEventEnvelope(envelope) };
}

export function buildProposalExpiringEvent({ proposalId, expiresAt, actor, occurredAt, correlationId }) {
  const type = 'proposal.expiring';
  const event_id = stableEventId({ type, correlationId, key: proposalId });

  const envelope = {
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

  return { ...envelope, signature: signEventEnvelope(envelope) };
}
