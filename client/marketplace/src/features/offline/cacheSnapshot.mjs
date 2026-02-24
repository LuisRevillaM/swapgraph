const SNAPSHOT_VERSION = 1;

function cloneSingleton(entry) {
  return {
    value: entry?.value ?? null,
    updatedAt: Number(entry?.updatedAt ?? 0)
  };
}

function cloneCollection(entry) {
  return {
    items: Array.isArray(entry?.items) ? entry.items : [],
    updatedAt: Number(entry?.updatedAt ?? 0)
  };
}

function cloneEntityMap(map) {
  const out = {};
  for (const [key, entry] of Object.entries(map ?? {})) {
    out[key] = {
      value: entry?.value ?? null,
      updatedAt: Number(entry?.updatedAt ?? 0)
    };
  }
  return out;
}

export function createCacheSnapshot(state) {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    caches: {
      health: cloneSingleton(state?.caches?.health),
      inventoryAwakening: cloneSingleton(state?.caches?.inventoryAwakening),
      intents: cloneCollection(state?.caches?.intents),
      proposals: cloneCollection(state?.caches?.proposals),
      timeline: cloneEntityMap(state?.caches?.timeline),
      receipts: cloneEntityMap(state?.caches?.receipts)
    }
  };
}

export function parseCacheSnapshot(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || parsed.version !== SNAPSHOT_VERSION) return null;
    if (!parsed.caches || typeof parsed.caches !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function applyCacheSnapshotToStore(store, snapshot) {
  if (!store || !snapshot?.caches) return false;

  if (snapshot.caches.health) {
    store.setSingletonCache('health', snapshot.caches.health.value ?? null);
  }
  if (snapshot.caches.inventoryAwakening) {
    store.setSingletonCache('inventoryAwakening', snapshot.caches.inventoryAwakening.value ?? null);
  }
  if (snapshot.caches.intents) {
    store.setCollectionCache('intents', Array.isArray(snapshot.caches.intents.items) ? snapshot.caches.intents.items : []);
  }
  if (snapshot.caches.proposals) {
    store.setCollectionCache('proposals', Array.isArray(snapshot.caches.proposals.items) ? snapshot.caches.proposals.items : []);
  }

  for (const [cycleId, entry] of Object.entries(snapshot.caches.timeline ?? {})) {
    if (!cycleId) continue;
    store.setEntityCache('timeline', cycleId, entry?.value ?? null);
  }

  for (const [cycleId, entry] of Object.entries(snapshot.caches.receipts ?? {})) {
    if (!cycleId) continue;
    store.setEntityCache('receipts', cycleId, entry?.value ?? null);
  }

  return true;
}

function hasEntries(entityMap) {
  return Object.keys(entityMap ?? {}).length > 0;
}

function hasReceiptByRouteId(receipts, routeReceiptId) {
  if (!routeReceiptId) return false;
  if (receipts?.[routeReceiptId]) return true;
  return Object.values(receipts ?? {}).some(entry => {
    const value = entry?.value ?? {};
    return String(value?.id ?? '') === String(routeReceiptId)
      || String(value?.cycleId ?? value?.cycle_id ?? '') === String(routeReceiptId);
  });
}

export function hasCachedReadSurface(snapshot, tab, params = {}) {
  const caches = snapshot?.caches ?? {};
  const normalizedTab = String(tab ?? '');

  if (normalizedTab === 'items') {
    return Boolean(caches?.inventoryAwakening?.value)
      || (Array.isArray(caches?.intents?.items) && caches.intents.items.length > 0);
  }
  if (normalizedTab === 'intents') {
    return Array.isArray(caches?.intents?.items) && caches.intents.items.length > 0;
  }
  if (normalizedTab === 'inbox') {
    return (Array.isArray(caches?.proposals?.items) && caches.proposals.items.length > 0)
      || (Array.isArray(caches?.intents?.items) && caches.intents.items.length > 0);
  }
  if (normalizedTab === 'active') {
    if (params?.cycleId) {
      return Boolean(caches?.timeline?.[params.cycleId]?.value);
    }
    return hasEntries(caches?.timeline);
  }
  if (normalizedTab === 'receipts') {
    if (params?.receiptId) return hasReceiptByRouteId(caches?.receipts, params.receiptId);
    return hasEntries(caches?.receipts);
  }

  return false;
}

export function staleBannerCopy({
  tab,
  offline = false,
  hasCache = false,
  savedAtMs = null
} = {}) {
  const tabLabel = String(tab ?? 'surface');
  const savedAt = savedAtMs && Number.isFinite(savedAtMs)
    ? new Date(savedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  if (offline && hasCache) {
    return {
      tone: 'caution',
      title: 'Offline mode',
      message: savedAt
        ? `Showing cached ${tabLabel} data from ${savedAt}. Values may be stale.`
        : `Showing cached ${tabLabel} data. Values may be stale.`
    };
  }

  if (offline && !hasCache) {
    return {
      tone: 'caution',
      title: 'Offline mode',
      message: `No cached ${tabLabel} data available yet.`
    };
  }

  return {
    tone: 'signal',
    title: 'Back online',
    message: 'Refreshing latest marketplace state.'
  };
}

