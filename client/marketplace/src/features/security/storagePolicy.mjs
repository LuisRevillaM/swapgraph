import { normalizeNotificationPrefs } from '../notifications/preferences.mjs';

const ACTOR_ID_PATTERN = /^[a-z0-9_:-]{2,72}$/i;
const ID_FIELD_PATTERN = /(^|_)(id|key|token|secret|signature|proof)($|_)/i;

const SNAPSHOT_LIMITS = Object.freeze({
  maxCollectionRows: 160,
  maxEntityRows: 160
});

function clipArray(rows, limit) {
  const input = Array.isArray(rows) ? rows : [];
  if (input.length <= limit) return input;
  return input.slice(0, limit);
}

function sanitizeReceiptForStorage(receipt) {
  if (!receipt || typeof receipt !== 'object') return receipt ?? null;
  const cloned = structuredClone(receipt);
  if (cloned.signature && typeof cloned.signature === 'object') {
    const signatureValue = String(cloned.signature.signature ?? '');
    cloned.signature.signature = signatureValue ? '[redacted]' : '';
    cloned.signature.signatureLength = signatureValue.length;
  }
  return cloned;
}

function sanitizeEntityMap(entityMap = {}, { maxRows = SNAPSHOT_LIMITS.maxEntityRows } = {}) {
  const entries = Object.entries(entityMap).slice(0, maxRows);
  const out = {};
  for (const [key, entry] of entries) {
    const value = entry?.value ?? null;
    out[key] = {
      value: key.startsWith('cycle_') ? sanitizeReceiptForStorage(value) : structuredClone(value),
      updatedAt: Number(entry?.updatedAt ?? 0)
    };
  }
  return out;
}

export function sanitizeActorId(rawActorId) {
  const candidate = String(rawActorId ?? '').trim();
  if (!candidate) return null;
  return ACTOR_ID_PATTERN.test(candidate) ? candidate : null;
}

export function createActorId(nowMs = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `web_user_${nowMs.toString(36)}_${rand}`;
}

export function sanitizeNotificationPrefsForStorage(prefs) {
  return normalizeNotificationPrefs(prefs);
}

export function sanitizeOfflineSnapshotForStorage(snapshot) {
  const caches = snapshot?.caches ?? {};
  return {
    version: Number(snapshot?.version ?? 1),
    savedAt: Number(snapshot?.savedAt ?? Date.now()),
    caches: {
      health: {
        value: caches?.health?.value ?? null,
        updatedAt: Number(caches?.health?.updatedAt ?? 0)
      },
      inventoryAwakening: {
        value: caches?.inventoryAwakening?.value ?? null,
        updatedAt: Number(caches?.inventoryAwakening?.updatedAt ?? 0)
      },
      intents: {
        items: clipArray(caches?.intents?.items, SNAPSHOT_LIMITS.maxCollectionRows),
        updatedAt: Number(caches?.intents?.updatedAt ?? 0)
      },
      proposals: {
        items: clipArray(caches?.proposals?.items, SNAPSHOT_LIMITS.maxCollectionRows),
        updatedAt: Number(caches?.proposals?.updatedAt ?? 0)
      },
      timeline: sanitizeEntityMap(caches?.timeline, { maxRows: SNAPSHOT_LIMITS.maxEntityRows }),
      receipts: sanitizeEntityMap(caches?.receipts, { maxRows: SNAPSHOT_LIMITS.maxEntityRows })
    }
  };
}

export function safeStorageRead(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageWrite(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function redactAnalyticsEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const payload = event?.payload && typeof event.payload === 'object'
    ? Object.fromEntries(Object.entries(event.payload).map(([key, value]) => {
      if (!ID_FIELD_PATTERN.test(key)) return [key, value];
      if (typeof value === 'boolean' || typeof value === 'number') return [key, value];
      return [key, '[redacted]'];
    }))
    : {};

  return {
    ...event,
    payload
  };
}
