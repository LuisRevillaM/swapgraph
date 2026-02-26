import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proposalCountsByIntent,
  watchStateForIntent
} from '../../../client/marketplace/src/features/intents/watchState.mjs';

test('proposalCountsByIntent counts unique proposal participation', () => {
  const proposals = [
    {
      id: 'p1',
      participants: [
        { intentId: 'intent_a' },
        { intentId: 'intent_b' }
      ]
    },
    {
      id: 'p2',
      participants: [
        { intentId: 'intent_a' },
        { intentId: 'intent_a' }
      ]
    }
  ];

  const counts = proposalCountsByIntent(proposals);
  assert.equal(counts.get('intent_a'), 2);
  assert.equal(counts.get('intent_b'), 1);
});

test('watchStateForIntent distinguishes watching, matched, and cancelled', () => {
  assert.equal(watchStateForIntent({ status: 'active' }, 0).kind, 'watching');
  assert.equal(watchStateForIntent({ status: 'active' }, 3).kind, 'matched');
  assert.equal(watchStateForIntent({ status: 'cancelled' }, 3).kind, 'cancelled');
});
