#!/usr/bin/env node
import { migrateStateStore } from '../src/store/stateStoreMigration.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/migrate-json-state-to-sqlite.mjs [options]',
    '',
    'Options:',
    '  --from-state-file <path>   source JSON state file path (optional)',
    '  --to-state-file <path>     target SQLite state file path (optional)',
    '  --force                    allow overwrite when target file exists',
    '  --help                     show usage'
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    fromBackend: 'json',
    toBackend: 'sqlite',
    fromStateFile: undefined,
    toStateFile: undefined,
    force: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--force') {
      options.force = true;
      continue;
    }
    if (token === '--from-state-file') {
      options.fromStateFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--to-state-file') {
      options.toStateFile = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = migrateStateStore(options);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  if (error?.message?.startsWith('unknown argument:')) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    process.exit(2);
    return;
  }

  console.error(JSON.stringify({
    ok: false,
    code: error?.code ?? 'json_to_sqlite_migration_failed',
    message: error instanceof Error ? error.message : 'json to sqlite migration failed',
    details: error?.details ?? {}
  }, null, 2));
  process.exit(1);
});
