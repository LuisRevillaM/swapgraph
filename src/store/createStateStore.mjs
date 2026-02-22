import path from 'node:path';

import { JsonStateStore } from './jsonStateStore.mjs';
import { SqliteStateStore } from './sqliteStateStore.mjs';

function normalizeBackend(value) {
  const normalized = String(value ?? 'json').trim().toLowerCase();
  if (normalized === 'json' || normalized === 'sqlite') return normalized;
  const error = new Error(`unsupported state backend: ${value}`);
  error.code = 'state_backend_unsupported';
  error.details = {
    backend: value,
    allowed_backends: ['json', 'sqlite']
  };
  throw error;
}

export function resolveStateStorePath({ backend, rootDir, storePath }) {
  const normalizedBackend = normalizeBackend(backend);
  const defaultFile = normalizedBackend === 'sqlite'
    ? 'data/runtime-api-state.sqlite'
    : 'data/runtime-api-state.json';
  return path.resolve(storePath ?? path.join(rootDir, defaultFile));
}

export function createStateStore({ backend, filePath }) {
  const normalizedBackend = normalizeBackend(backend);
  if (normalizedBackend === 'sqlite') {
    return new SqliteStateStore({ filePath });
  }
  return new JsonStateStore({ filePath });
}
