function randomPart() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function createIdempotencyKey(prefix = 'web') {
  const safePrefix = String(prefix || 'web').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'web';
  return `${safePrefix}_${randomPart()}`;
}

export function isMutationMethod(method) {
  const normalized = String(method || 'GET').toUpperCase();
  return normalized === 'POST' || normalized === 'PATCH' || normalized === 'PUT' || normalized === 'DELETE';
}
