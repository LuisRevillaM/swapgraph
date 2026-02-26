import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRouteHash, parseHashRoute } from '../../../client/marketplace/src/routing/router.mjs';

test('parseHashRoute resolves base tabs and deep links', () => {
  const items = parseHashRoute('#/items');
  assert.equal(items.tab, 'items');
  assert.equal(items.path, '/items');

  const proposal = parseHashRoute('#/inbox/proposal/proposal_123');
  assert.equal(proposal.tab, 'inbox');
  assert.equal(proposal.deepLinkKind, 'proposal');
  assert.equal(proposal.params.proposalId, 'proposal_123');

  const receipt = parseHashRoute('#/receipts/rcpt_42');
  assert.equal(receipt.tab, 'receipts');
  assert.equal(receipt.params.receiptId, 'rcpt_42');
});

test('buildRouteHash emits canonical deep-link hashes', () => {
  assert.equal(buildRouteHash({ tab: 'items' }), '#/items');
  assert.equal(buildRouteHash({ tab: 'inbox', params: { proposalId: 'p-1' } }), '#/inbox/proposal/p-1');
  assert.equal(buildRouteHash({ tab: 'active', params: { cycleId: 'cy_9' } }), '#/active/cycle/cy_9');
  assert.equal(buildRouteHash({ tab: 'receipts', params: { receiptId: 'r_7' } }), '#/receipts/r_7');
});
