import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { createRuntimeApiServer } from '../src/server/runtimeApiServer.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';
import { createStateStore } from '../src/store/createStateStore.mjs';
import { migrateStateStore } from '../src/store/stateStoreMigration.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M112';
const SCENARIO_FILE = 'fixtures/release/m112_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m112_expected.json';
const OUTPUT_FILE = 'storage_hardening_output.json';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function summarizeStateCounts(state) {
  return {
    intents: Object.keys(state?.intents ?? {}).length,
    proposals: Object.keys(state?.proposals ?? {}).length,
    commits: Object.keys(state?.commits ?? {}).length,
    receipts: Object.keys(state?.receipts ?? {}).length,
    idempotency_keys: Object.keys(state?.idempotency ?? {}).length,
    events: Array.isArray(state?.events) ? state.events.length : 0
  };
}

function runIntentCreate({ service, actor, auth, idempotencyKey, request }) {
  const out = service.create({
    actor,
    auth,
    idempotencyKey,
    requestBody: request
  });
  assert.equal(out.result?.ok, true, `swapIntents.create should pass for intent ${request?.intent?.id ?? 'unknown'}`);
  return out.result?.body ?? {};
}

function runIntentList({ service, actor, auth }) {
  const out = service.list({ actor, auth });
  assert.equal(out?.ok, true, 'swapIntents.list should pass');
  return out.body?.intents ?? [];
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));

const actor = clone(scenario.actor);
const scopes = clone(scenario.scopes ?? []);
const requests = clone(scenario.intent_requests ?? []);
if (!actor?.type || !actor?.id) throw new Error('scenario actor is required');
if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('scenario scopes are required');
if (!Array.isArray(requests) || requests.length < 2) throw new Error('scenario intent_requests must include at least two requests');

const jsonStatePath = path.join(outDir, 'runtime-api-state.json');
const sqliteStatePath = path.join(outDir, 'runtime-api-state.sqlite');
const backupJsonPath = path.join(outDir, 'runtime-api-state.backup.json');
const restoredSqliteStatePath = path.join(outDir, 'runtime-api-state-restored.sqlite');

for (const filePath of [jsonStatePath, sqliteStatePath, backupJsonPath, restoredSqliteStatePath]) {
  rmSync(filePath, { force: true });
}

const operations = [];
const auth = { scopes };

const runtimeJson = createRuntimeApiServer({
  host: '127.0.0.1',
  port: 0,
  stateBackend: 'json',
  storePath: jsonStatePath
});
operations.push({
  op: 'runtime.bootstrap.json',
  store_backend: runtimeJson.storeBackend,
  persistence_mode: runtimeJson.persistenceMode
});
assert.equal(runtimeJson.storeBackend, 'json', 'json runtime should report json backend');
assert.equal(runtimeJson.persistenceMode, 'json_file', 'json runtime should report json_file persistence mode');
await runtimeJson.close();

const jsonStore = createStateStore({ backend: 'json', filePath: jsonStatePath });
jsonStore.load();
const jsonService = new SwapIntentsService({ store: jsonStore });

const createA = runIntentCreate({
  service: jsonService,
  actor,
  auth,
  idempotencyKey: requests[0].idempotency_key,
  request: requests[0].request
});
operations.push({
  op: 'swapIntents.create.json',
  intent_id: requests[0].request?.intent?.id ?? null,
  correlation_id: createA.correlation_id ?? null
});

const jsonIntents = runIntentList({ service: jsonService, actor, auth });
assert.equal(jsonIntents.length, 1, 'json store should contain one intent before migration');
operations.push({
  op: 'swapIntents.list.json',
  intents_count: jsonIntents.length
});

jsonStore.save();
if (typeof jsonStore.close === 'function') jsonStore.close();

const migrateJsonToSqlite = migrateStateStore({
  fromBackend: 'json',
  fromStateFile: jsonStatePath,
  toBackend: 'sqlite',
  toStateFile: sqliteStatePath,
  force: true
});
operations.push({
  op: 'state.migrate.json_to_sqlite',
  state_sha256: migrateJsonToSqlite.state_sha256,
  counts: migrateJsonToSqlite.counts
});

const runtimeSqlite = createRuntimeApiServer({
  host: '127.0.0.1',
  port: 0,
  stateBackend: 'sqlite',
  storePath: sqliteStatePath
});
operations.push({
  op: 'runtime.bootstrap.sqlite',
  store_backend: runtimeSqlite.storeBackend,
  persistence_mode: runtimeSqlite.persistenceMode
});
assert.equal(runtimeSqlite.storeBackend, 'sqlite', 'sqlite runtime should report sqlite backend');
assert.equal(runtimeSqlite.persistenceMode, 'sqlite_wal', 'sqlite runtime should report sqlite_wal persistence mode');
await runtimeSqlite.close();

const sqliteStore = createStateStore({ backend: 'sqlite', filePath: sqliteStatePath });
sqliteStore.load();
const sqliteService = new SwapIntentsService({ store: sqliteStore });

const sqliteIntentsAfterMigration = runIntentList({ service: sqliteService, actor, auth });
assert.equal(sqliteIntentsAfterMigration.length, 1, 'sqlite store should contain migrated intent');
operations.push({
  op: 'swapIntents.list.sqlite.after_migration',
  intents_count: sqliteIntentsAfterMigration.length
});

const createB = runIntentCreate({
  service: sqliteService,
  actor,
  auth,
  idempotencyKey: requests[1].idempotency_key,
  request: requests[1].request
});
operations.push({
  op: 'swapIntents.create.sqlite',
  intent_id: requests[1].request?.intent?.id ?? null,
  correlation_id: createB.correlation_id ?? null
});

const sqliteIntentsAfterCreate = runIntentList({ service: sqliteService, actor, auth });
assert.equal(sqliteIntentsAfterCreate.length, 2, 'sqlite store should contain two intents after write');
operations.push({
  op: 'swapIntents.list.sqlite.after_write',
  intents_count: sqliteIntentsAfterCreate.length
});

sqliteStore.save();
if (typeof sqliteStore.close === 'function') sqliteStore.close();

const sqliteRestartStore = createStateStore({ backend: 'sqlite', filePath: sqliteStatePath });
sqliteRestartStore.load();
const sqliteRestartService = new SwapIntentsService({ store: sqliteRestartStore });
const sqliteIntentsAfterRestart = runIntentList({ service: sqliteRestartService, actor, auth });
assert.equal(sqliteIntentsAfterRestart.length, 2, 'sqlite store should persist two intents across restart');
operations.push({
  op: 'swapIntents.list.sqlite.after_restart',
  intents_count: sqliteIntentsAfterRestart.length
});
if (typeof sqliteRestartStore.close === 'function') sqliteRestartStore.close();

const backupSqliteToJson = migrateStateStore({
  fromBackend: 'sqlite',
  fromStateFile: sqliteStatePath,
  toBackend: 'json',
  toStateFile: backupJsonPath,
  force: true
});
operations.push({
  op: 'state.backup.sqlite_to_json',
  state_sha256: backupSqliteToJson.state_sha256,
  counts: backupSqliteToJson.counts
});

const restoreJsonToSqlite = migrateStateStore({
  fromBackend: 'json',
  fromStateFile: backupJsonPath,
  toBackend: 'sqlite',
  toStateFile: restoredSqliteStatePath,
  force: true
});
operations.push({
  op: 'state.restore.json_to_sqlite',
  state_sha256: restoreJsonToSqlite.state_sha256,
  counts: restoreJsonToSqlite.counts
});

const restoredStore = createStateStore({ backend: 'sqlite', filePath: restoredSqliteStatePath });
restoredStore.load();
const restoredIntentIds = Object.values(restoredStore.state?.intents ?? {})
  .map(intent => intent?.id ?? null)
  .filter(Boolean)
  .sort();
const restoredCounts = summarizeStateCounts(restoredStore.state);
if (typeof restoredStore.close === 'function') restoredStore.close();

const out = canonicalize({
  operations,
  hashes: {
    json_to_sqlite: migrateJsonToSqlite.state_sha256,
    sqlite_to_json: backupSqliteToJson.state_sha256,
    json_to_sqlite_restore: restoreJsonToSqlite.state_sha256
  },
  restored: {
    intent_ids: restoredIntentIds,
    counts: restoredCounts
  }
});
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: outHash,
  matched: outHash === expected.expected_sha256,
  operations_count: operations.length,
  restored_intents_count: restoredIntentIds.length
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
