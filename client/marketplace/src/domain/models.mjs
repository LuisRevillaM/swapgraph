export const DOMAIN_MODEL_VERSION = 'web-m1';

export function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

export function asIsoDate(value, fallback = null) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeActorRef(actor, fallbackType = 'unknown', fallbackId = 'unknown') {
  return {
    type: asString(actor?.type, fallbackType),
    id: asString(actor?.id, fallbackId)
  };
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) deepFreeze(entry);
  }
  return value;
}
