export const SW_MODE_STORAGE_KEY = 'swapgraph.marketplace.sw_mode';

function storageMode(windowRef) {
  try {
    const value = windowRef?.localStorage?.getItem(SW_MODE_STORAGE_KEY);
    if (!value) return null;
    return String(value).trim().toLowerCase();
  } catch {
    return null;
  }
}

export function serviceWorkerMode(windowRef) {
  const search = String(windowRef?.location?.search ?? '');
  const params = new URLSearchParams(search);
  const queryMode = String(params.get('sw') ?? '').trim().toLowerCase();
  if (queryMode === 'off') return 'off';
  if (queryMode === 'on') return 'on';

  const persisted = storageMode(windowRef);
  if (persisted === 'off') return 'off';
  return 'on';
}

export async function disableServiceWorkerForRollback(windowRef) {
  const registrations = await windowRef?.navigator?.serviceWorker?.getRegistrations?.() ?? [];
  let unregistered = 0;
  for (const registration of registrations) {
    try {
      const ok = await registration.unregister();
      if (ok) unregistered += 1;
    } catch {
      // ignore and continue
    }
  }

  let cachesCleared = 0;
  const cacheKeys = await windowRef?.caches?.keys?.() ?? [];
  for (const key of cacheKeys) {
    if (!String(key).startsWith('swapgraph-marketplace-shell')) continue;
    try {
      const removed = await windowRef.caches.delete(key);
      if (removed) cachesCleared += 1;
    } catch {
      // ignore and continue
    }
  }

  return {
    mode: 'off',
    unregistered,
    cachesCleared
  };
}
