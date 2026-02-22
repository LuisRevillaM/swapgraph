import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { canonicalize } from '../util/canonicalJson.mjs';
import { JsonStateStore } from './jsonStateStore.mjs';

const require = createRequire(import.meta.url);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(defaultValue, loadedValue) {
  if (loadedValue === undefined) return clone(defaultValue);

  if (Array.isArray(defaultValue)) {
    return Array.isArray(loadedValue) ? loadedValue : clone(defaultValue);
  }

  if (isPlainObject(defaultValue)) {
    const out = {};
    const loadedObj = isPlainObject(loadedValue) ? loadedValue : {};

    for (const key of Object.keys(defaultValue)) {
      out[key] = mergeDefaults(defaultValue[key], loadedObj[key]);
    }

    for (const [key, value] of Object.entries(loadedObj)) {
      if (!(key in out)) out[key] = value;
    }

    return out;
  }

  return loadedValue;
}

function defaultStateSnapshot(filePath) {
  const store = new JsonStateStore({ filePath: `${filePath}.defaults` });
  return clone(store.state);
}

function loadSqliteModule() {
  try {
    return require('node:sqlite');
  } catch (error) {
    const wrapped = new Error('sqlite backend is unavailable in this Node runtime');
    wrapped.code = 'sqlite_unavailable';
    wrapped.cause = error;
    throw wrapped;
  }
}

export class SqliteStateStore {
  /**
   * @param {{ filePath: string }} opts
   */
  constructor({ filePath }) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = filePath;
    this.state = defaultStateSnapshot(filePath);
    this._db = null;
    this._DatabaseSync = null;
  }

  _open() {
    if (this._db) return this._db;

    const { DatabaseSync } = loadSqliteModule();
    this._DatabaseSync = DatabaseSync;
    mkdirSync(path.dirname(this.filePath), { recursive: true });

    const db = new DatabaseSync(this.filePath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS state_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this._db = db;
    return db;
  }

  load() {
    const db = this._open();
    const row = db.prepare('SELECT state_json FROM state_snapshots WHERE id = 1').get();

    if (!row?.state_json) {
      this.state = defaultStateSnapshot(this.filePath);
      return;
    }

    const parsed = JSON.parse(row.state_json);
    const defaults = defaultStateSnapshot(this.filePath);
    this.state = mergeDefaults(defaults, parsed);
  }

  save() {
    const db = this._open();
    const payload = JSON.stringify(canonicalize(this.state));
    const updatedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO state_snapshots (id, state_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(payload, updatedAt);
  }

  close() {
    if (!this._db) return;
    this._db.close();
    this._db = null;
  }
}
