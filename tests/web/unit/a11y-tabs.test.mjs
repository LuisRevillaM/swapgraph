import test from 'node:test';
import assert from 'node:assert/strict';

import { keyboardNextTab, knownTabs, panelA11yId, tabA11yId } from '../../../client/marketplace/src/features/accessibility/tabs.mjs';

test('keyboardNextTab cycles tabs with arrow/home/end controls', () => {
  assert.equal(keyboardNextTab({ activeTab: 'items', key: 'ArrowRight' }), 'intents');
  assert.equal(keyboardNextTab({ activeTab: 'items', key: 'ArrowLeft' }), 'receipts');
  assert.equal(keyboardNextTab({ activeTab: 'inbox', key: 'Home' }), 'items');
  assert.equal(keyboardNextTab({ activeTab: 'inbox', key: 'End' }), 'receipts');
  assert.equal(keyboardNextTab({ activeTab: 'inbox', key: 'Enter' }), null);
});

test('tab and panel accessibility ids stay deterministic', () => {
  const tabs = knownTabs();
  assert.deepEqual(tabs, ['items', 'intents', 'inbox', 'active', 'receipts']);
  assert.equal(tabA11yId('items'), 'marketplace-tab-items');
  assert.equal(panelA11yId('receipts'), 'marketplace-panel-receipts');
});
