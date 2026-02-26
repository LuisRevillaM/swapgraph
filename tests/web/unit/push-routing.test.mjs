import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePushPayload, routeForPushPayload } from '../../../client/marketplace/src/features/notifications/pushRouting.mjs';

test('normalizePushPayload handles proposal, active, and receipt variants', () => {
  const proposal = normalizePushPayload({ type: 'proposal.available', proposal_id: 'proposal_1' });
  assert.equal(proposal.kind, 'proposal');
  assert.equal(proposal.proposalId, 'proposal_1');

  const active = normalizePushPayload({ notification_type: 'active.swap.update', cycle_id: 'cycle_1' });
  assert.equal(active.kind, 'active');
  assert.equal(active.cycleId, 'cycle_1');

  const receipt = normalizePushPayload({ kind: 'receipt.ready', receipt_id: 'cycle_2' });
  assert.equal(receipt.kind, 'receipt');
  assert.equal(receipt.cycleId, 'cycle_2');
});

test('routeForPushPayload maps each push kind to expected route', () => {
  assert.deepEqual(routeForPushPayload({ type: 'proposal', proposal_id: 'proposal_1' }), {
    tab: 'inbox',
    params: { proposalId: 'proposal_1' }
  });

  assert.deepEqual(routeForPushPayload({ type: 'active', cycle_id: 'cycle_1' }), {
    tab: 'active',
    params: { cycleId: 'cycle_1' }
  });

  assert.deepEqual(routeForPushPayload({ type: 'receipt', cycle_id: 'cycle_2' }), {
    tab: 'receipts',
    params: { receiptId: 'cycle_2' }
  });
});

test('invalid push payloads are rejected', () => {
  assert.equal(normalizePushPayload(null), null);
  assert.equal(normalizePushPayload({ type: 'proposal' }), null);
  assert.equal(routeForPushPayload({ type: 'unknown', id: 'x' }), null);
});

