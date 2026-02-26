import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketplaceApiClient } from '../../../client/marketplace/src/api/apiClient.mjs';

function okResponse(body, status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers({ 'x-correlation-id': 'corr_proposal' }),
    text: async () => JSON.stringify(body)
  };
}

test('acceptProposal sends commits scope, idempotency key, and schema-conformant payload', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({
        correlation_id: 'corr_p_accept',
        commit: { id: 'commit_1', cycle_id: 'proposal_1', phase: 'accept', participants: [] }
      });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['commits:write'] })
  });

  const out = await client.acceptProposal({
    proposalId: 'proposal_1',
    idempotencyKey: 'idem_accept_1'
  });

  assert.equal(out.commit.id, 'commit_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/cycle-proposals/proposal_1/accept'), true);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_accept_1');
  assert.equal(calls[0].init.headers['x-auth-scopes'], 'commits:write');

  const parsedBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(parsedBody, { proposal_id: 'proposal_1' });
});

test('declineProposal sends commits scope and returns commit payload', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({
        correlation_id: 'corr_p_decline',
        commit: { id: 'commit_2', cycle_id: 'proposal_2', phase: 'cancelled', participants: [] }
      });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['commits:write'] })
  });

  const out = await client.declineProposal({
    proposalId: 'proposal_2',
    idempotencyKey: 'idem_decline_1'
  });

  assert.equal(out.commit.id, 'commit_2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/cycle-proposals/proposal_2/decline'), true);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_decline_1');
  assert.equal(calls[0].init.headers['x-auth-scopes'], 'commits:write');

  const parsedBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(parsedBody, { proposal_id: 'proposal_2' });
});
