import {
  createActorId,
  safeStorageRead,
  safeStorageWrite,
  sanitizeActorId
} from '../features/security/storagePolicy.mjs';

export const SESSION_ACTOR_STORAGE_KEY = 'swapgraph.marketplace.actor_id';
const SESSION_ACTOR_QUERY_KEYS = ['actor_id', 'actor'];

export function actorIdFromLocationSearch(locationSearch = '') {
  const query = typeof locationSearch === 'string' ? locationSearch.trim() : '';
  if (!query) return null;

  const params = new URLSearchParams(query.startsWith('?') ? query : `?${query}`);
  for (const key of SESSION_ACTOR_QUERY_KEYS) {
    const candidate = sanitizeActorId(params.get(key));
    if (candidate) return candidate;
  }

  return null;
}

export function loadOrCreateActorId({ storage = null, locationSearch = '' } = {}) {
  const fromQuery = actorIdFromLocationSearch(locationSearch);
  if (fromQuery) {
    safeStorageWrite(storage, SESSION_ACTOR_STORAGE_KEY, fromQuery);
    return fromQuery;
  }

  const existing = sanitizeActorId(safeStorageRead(storage, SESSION_ACTOR_STORAGE_KEY));
  if (existing) return existing;

  const generated = createActorId();
  safeStorageWrite(storage, SESSION_ACTOR_STORAGE_KEY, generated);
  return generated;
}
