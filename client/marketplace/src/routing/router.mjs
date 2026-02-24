import { DEFAULT_TAB_ID } from '../app/tabs.mjs';

const ROUTE_DEFINITIONS = [
  { pattern: /^\/items\/?$/, tab: 'items', deepLinkKind: null, keys: [] },
  { pattern: /^\/intents\/?$/, tab: 'intents', deepLinkKind: null, keys: [] },
  { pattern: /^\/inbox\/?$/, tab: 'inbox', deepLinkKind: null, keys: [] },
  { pattern: /^\/inbox\/proposal\/([^/]+)\/?$/, tab: 'inbox', deepLinkKind: 'proposal', keys: ['proposalId'] },
  { pattern: /^\/active\/?$/, tab: 'active', deepLinkKind: null, keys: [] },
  { pattern: /^\/active\/cycle\/([^/]+)\/?$/, tab: 'active', deepLinkKind: 'cycle', keys: ['cycleId'] },
  { pattern: /^\/receipts\/?$/, tab: 'receipts', deepLinkKind: null, keys: [] },
  { pattern: /^\/receipts\/([^/]+)\/?$/, tab: 'receipts', deepLinkKind: 'receipt', keys: ['receiptId'] }
];

export function normalizeHashPath(rawHash) {
  const safe = typeof rawHash === 'string' ? rawHash.trim() : '';
  if (!safe || safe === '#' || safe === '#/') return '/items';
  const withoutHash = safe.startsWith('#') ? safe.slice(1) : safe;
  const withLeadingSlash = withoutHash.startsWith('/') ? withoutHash : `/${withoutHash}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/');
}

export function parseHashRoute(rawHash) {
  const path = normalizeHashPath(rawHash);

  for (const definition of ROUTE_DEFINITIONS) {
    const match = definition.pattern.exec(path);
    if (!match) continue;

    const params = {};
    definition.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });

    return {
      path,
      tab: definition.tab,
      deepLinkKind: definition.deepLinkKind,
      params,
      hash: `#${path}`
    };
  }

  return {
    path: '/items',
    tab: DEFAULT_TAB_ID,
    deepLinkKind: null,
    params: {},
    hash: '#/items'
  };
}

export function buildRouteHash({ tab, params = {} }) {
  switch (tab) {
    case 'inbox':
      if (params.proposalId) return `#/inbox/proposal/${encodeURIComponent(String(params.proposalId))}`;
      return '#/inbox';
    case 'active':
      if (params.cycleId) return `#/active/cycle/${encodeURIComponent(String(params.cycleId))}`;
      return '#/active';
    case 'receipts':
      if (params.receiptId) return `#/receipts/${encodeURIComponent(String(params.receiptId))}`;
      return '#/receipts';
    case 'intents':
      return '#/intents';
    case 'items':
    default:
      return '#/items';
  }
}

export function createHashRouter({ windowRef = window, onRouteChange }) {
  if (!windowRef || typeof windowRef.addEventListener !== 'function') {
    throw new Error('windowRef with addEventListener is required');
  }

  let currentRoute = parseHashRoute(windowRef.location?.hash ?? '');
  let started = false;

  const notify = () => {
    currentRoute = parseHashRoute(windowRef.location?.hash ?? '');
    if (typeof onRouteChange === 'function') onRouteChange(currentRoute);
    return currentRoute;
  };

  const handleHashChange = () => {
    notify();
  };

  return {
    start() {
      if (started) return currentRoute;
      started = true;
      windowRef.addEventListener('hashchange', handleHashChange);
      if (!windowRef.location.hash) {
        windowRef.location.hash = '#/items';
      }
      return notify();
    },

    stop() {
      if (!started) return;
      started = false;
      windowRef.removeEventListener('hashchange', handleHashChange);
    },

    navigate(input, options = {}) {
      const hash = typeof input === 'string'
        ? (input.startsWith('#') ? input : `#${normalizeHashPath(input)}`)
        : buildRouteHash(input ?? {});

      if (options.replace && windowRef.history?.replaceState) {
        const { pathname, search } = windowRef.location;
        windowRef.history.replaceState(null, '', `${pathname}${search}${hash}`);
        return notify();
      }

      if (windowRef.location.hash === hash) {
        return notify();
      }

      windowRef.location.hash = hash;
      return parseHashRoute(hash);
    },

    current() {
      return currentRoute;
    }
  };
}
