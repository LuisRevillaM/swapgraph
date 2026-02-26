import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTabScreen } from '../../../client/marketplace/src/ui/screens.mjs';

function baseState() {
  const nowMs = Date.now();
  const urgentExpiry = new Date(nowMs + 30 * 60 * 1000).toISOString();
  const rankedExpiry = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString();

  return {
    route: { tab: 'inbox', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      intentMutations: {},
      proposalMutations: {}
    },
    caches: {
      inventoryAwakening: { value: null },
      intents: {
        items: [
          {
            id: 'intent_user',
            actor: { type: 'user', id: 'user_1' }
          }
        ]
      },
      proposals: {
        items: [
          {
            id: 'proposal_urgent',
            expiresAt: urgentExpiry,
            confidenceScore: 0.76,
            explainability: ['value_delta', 'confidence', 'constraint_fit'],
            participants: [
              {
                intentId: 'intent_user',
                actor: { type: 'user', id: 'user_1' },
                give: [{ assetId: 'give_1', label: 'AK-47 Redline', wear: 'MW', valueUsd: 110 }],
                get: [{ assetId: 'get_1', label: 'Karambit Forest DDPAT', wear: 'FT', valueUsd: 125 }]
              }
            ]
          },
          {
            id: 'proposal_ranked',
            expiresAt: rankedExpiry,
            confidenceScore: 0.84,
            explainability: ['value_delta', 'confidence', 'constraint_fit'],
            participants: [
              {
                intentId: 'intent_user',
                actor: { type: 'user', id: 'user_1' },
                give: [{ assetId: 'give_2', label: 'USP-S Kill Confirmed', wear: 'FN', valueUsd: 90 }],
                get: [{ assetId: 'get_2', label: 'Nomad Knife Crimson Web', wear: 'MW', valueUsd: 118 }]
              }
            ]
          }
        ]
      },
      health: { value: null },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

test('inbox renders ranked proposal sections with urgency and metadata', () => {
  const state = baseState();
  const html = renderTabScreen(state);

  assert.match(html, /Proposal Inbox/);
  assert.match(html, /Urgent decisions/);
  assert.match(html, /Ranked opportunities/);
  assert.match(html, /data-action="inbox.openProposal"/);
  assert.match(html, /confidence/);
});

test('proposal detail renders explainability cards and decision actions', () => {
  const state = baseState();
  state.route.params = { proposalId: 'proposal_urgent' };

  const html = renderTabScreen(state);
  assert.match(html, /Proposal Detail/);
  assert.match(html, /Why this proposal/);
  assert.match(html, /data-action="proposal.accept"/);
  assert.match(html, /data-action="proposal.decline"/);
  assert.match(html, /Value delta/);
});

test('proposal detail reflects mutation pending and settled statuses', () => {
  const state = baseState();
  state.route.params = { proposalId: 'proposal_urgent' };
  state.ui.proposalMutations.proposal_urgent = {
    pending: false,
    decision: 'accept',
    status: 'accepted',
    error: null
  };

  const html = renderTabScreen(state);
  assert.match(html, /Decision recorded: accepted/);
  assert.match(html, /disabled/);
});
