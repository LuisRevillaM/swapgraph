const TAB_ORDER = Object.freeze(['items', 'intents', 'inbox', 'active', 'receipts']);

function normalizeTab(tab) {
  return TAB_ORDER.includes(tab) ? tab : TAB_ORDER[0];
}

function wrapIndex(index) {
  if (index < 0) return TAB_ORDER.length - 1;
  if (index >= TAB_ORDER.length) return 0;
  return index;
}

export function keyboardNextTab({ activeTab, key }) {
  const normalized = normalizeTab(activeTab);
  const currentIndex = TAB_ORDER.indexOf(normalized);

  if (key === 'ArrowRight') return TAB_ORDER[wrapIndex(currentIndex + 1)];
  if (key === 'ArrowLeft') return TAB_ORDER[wrapIndex(currentIndex - 1)];
  if (key === 'Home') return TAB_ORDER[0];
  if (key === 'End') return TAB_ORDER[TAB_ORDER.length - 1];
  return null;
}

export function tabA11yId(tabId) {
  return `marketplace-tab-${normalizeTab(tabId)}`;
}

export function panelA11yId(tabId) {
  return `marketplace-panel-${normalizeTab(tabId)}`;
}

export function knownTabs() {
  return TAB_ORDER.slice();
}
