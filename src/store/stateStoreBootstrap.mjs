import { existsSync } from 'node:fs';

import { migrateStateStore } from './stateStoreMigration.mjs';
import { resolveStateStorePath } from './createStateStore.mjs';

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function inferSourcePath({ targetPath, fromBackend }) {
  if (!targetPath) return undefined;
  if (fromBackend !== 'json') return undefined;
  if (targetPath.endsWith('.sqlite')) {
    return targetPath.slice(0, -'.sqlite'.length) + '.json';
  }
  return undefined;
}

export function maybeBootstrapStateMigration({
  env = process.env,
  rootDir = process.cwd(),
  stateBackend,
  storePath
} = {}) {
  if (String(stateBackend ?? 'json').trim().toLowerCase() !== 'sqlite') {
    return {
      ok: true,
      skipped: true,
      reason: 'target_backend_not_sqlite'
    };
  }

  if (!envFlag(env.STATE_BOOTSTRAP_MIGRATION)) {
    return {
      ok: true,
      skipped: true,
      reason: 'bootstrap_disabled'
    };
  }

  const fromBackend = String(env.STATE_BOOTSTRAP_FROM_BACKEND ?? 'json').trim().toLowerCase();
  const toPath = resolveStateStorePath({ backend: stateBackend, rootDir, storePath });
  const fromStateFile = env.STATE_BOOTSTRAP_FROM_STATE_FILE
    ? String(env.STATE_BOOTSTRAP_FROM_STATE_FILE)
    : inferSourcePath({ targetPath: toPath, fromBackend });
  const sourcePath = resolveStateStorePath({ backend: fromBackend, rootDir, storePath: fromStateFile });

  if (existsSync(toPath) && !envFlag(env.STATE_BOOTSTRAP_FORCE)) {
    return {
      ok: true,
      skipped: true,
      reason: 'target_exists',
      from_backend: fromBackend,
      from_state_file: sourcePath,
      to_backend: 'sqlite',
      to_state_file: toPath
    };
  }

  const result = migrateStateStore({
    fromBackend,
    fromStateFile,
    toBackend: 'sqlite',
    toStateFile: toPath,
    rootDir,
    force: envFlag(env.STATE_BOOTSTRAP_FORCE)
  });

  return {
    ...result,
    skipped: false,
    reason: 'migrated_on_boot'
  };
}
