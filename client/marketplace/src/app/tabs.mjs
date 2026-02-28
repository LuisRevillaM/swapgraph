export const MARKETPLACE_TABS = Object.freeze([
  { id: 'items', label: 'My Items', icon: '◇', href: '#/items' },
  { id: 'intents', label: 'Trades', icon: '◎', href: '#/intents' },
  { id: 'inbox', label: 'Matches', icon: '⬡', href: '#/inbox' },
  { id: 'active', label: 'In Progress', icon: '▸', href: '#/active' },
  { id: 'receipts', label: 'History', icon: '☰', href: '#/receipts' }
]);

export const DEFAULT_TAB_ID = 'items';

export function findTab(tabId) {
  return MARKETPLACE_TABS.find(tab => tab.id === tabId) ?? MARKETPLACE_TABS[0];
}

export function isKnownTab(tabId) {
  return MARKETPLACE_TABS.some(tab => tab.id === tabId);
}
