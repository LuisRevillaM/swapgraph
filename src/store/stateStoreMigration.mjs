import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { canonicalStringify } from '../util/canonicalJson.mjs';
import { createStateStore, resolveStateStorePath } from './createStateStore.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Hex(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function summarizeState(state) {
  return {
    intents: Object.keys(state?.intents ?? {}).length,
    proposals: Object.keys(state?.proposals ?? {}).length,
    commits: Object.keys(state?.commits ?? {}).length,
    receipts: Object.keys(state?.receipts ?? {}).length,
    events: Array.isArray(state?.events) ? state.events.length : 0,
    idempotency_keys: Object.keys(state?.idempotency ?? {}).length
  };
}

function errorWithCode(message, code, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

export function migrateStateStore({
  fromBackend = 'json',
  fromStateFile,
  toBackend = 'sqlite',
  toStateFile,
  rootDir = process.cwd(),
  force = false
}) {
  const fromPath = resolveStateStorePath({ backend: fromBackend, rootDir, storePath: fromStateFile });
  const toPath = resolveStateStorePath({ backend: toBackend, rootDir, storePath: toStateFile });

  if (!existsSync(fromPath)) {
    throw errorWithCode(
      `source state file does not exist: ${fromPath}`,
      'state_migration_source_missing',
      { from_backend: fromBackend, from_state_file: fromPath }
    );
  }

  if (!force && existsSync(toPath)) {
    throw errorWithCode(
      `target state file already exists: ${toPath}`,
      'state_migration_target_exists',
      { to_backend: toBackend, to_state_file: toPath }
    );
  }

  const fromStore = createStateStore({ backend: fromBackend, filePath: fromPath });
  const toStore = createStateStore({ backend: toBackend, filePath: toPath });

  let migratedState;
  let sourceHash;
  let targetHash;

  try {
    fromStore.load();
    migratedState = clone(fromStore.state);
    sourceHash = sha256Hex(migratedState);

    toStore.state = clone(migratedState);
    toStore.save();
    toStore.load();
    targetHash = sha256Hex(toStore.state);
  } finally {
    if (typeof fromStore.close === 'function') fromStore.close();
    if (typeof toStore.close === 'function') toStore.close();
  }

  if (sourceHash !== targetHash) {
    throw errorWithCode(
      'state hash mismatch after migration',
      'state_migration_hash_mismatch',
      { source_hash: sourceHash, target_hash: targetHash }
    );
  }

  return {
    ok: true,
    from_backend: String(fromBackend).trim().toLowerCase(),
    from_state_file: fromPath,
    to_backend: String(toBackend).trim().toLowerCase(),
    to_state_file: toPath,
    state_sha256: targetHash,
    counts: summarizeState(migratedState)
  };
}
