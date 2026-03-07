export const MARKETPLACE_TABS = Object.freeze([
  { id: 'items', label: 'Items', icon: '◇', href: '#/items' },
  { id: 'intents', label: 'Intents', icon: '◎', href: '#/intents' },
  { id: 'inbox', label: 'Inbox', icon: '⬡', href: '#/inbox' },
  { id: 'active', label: 'Active', icon: '▸', href: '#/active' },
  { id: 'receipts', label: 'Receipts', icon: '☰', href: '#/receipts' }
]);

export const DEFAULT_TAB_ID = 'items';

export function findTab(tabId) {
  return MARKETPLACE_TABS.find(tab => tab.id === tabId) ?? MARKETPLACE_TABS[0];
}

export function isKnownTab(tabId) {
  return MARKETPLACE_TABS.some(tab => tab.id === tabId);
}
