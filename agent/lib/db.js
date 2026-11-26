import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, dataDir } from './config.js';
import { nowIso } from './util.js';

let db = null;
let inTransaction = false;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  schema TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  author_name TEXT,
  author_handle TEXT,
  published_at TEXT,
  language TEXT,
  title TEXT,
  text TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  links_json TEXT NOT NULL DEFAULT '[]',
  quoted_json TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY REFERENCES captures(id),
  title TEXT,
  summary TEXT,
  category_l1 TEXT NOT NULL DEFAULT 'inbox',
  category_l2 TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  analysis_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  processing_mode TEXT NOT NULL DEFAULT 'full',
  error TEXT,
  category_source TEXT NOT NULL DEFAULT 'auto',
  category_updated_at TEXT,
  markdown_path TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  key TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  parent_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL DEFAULT 'system',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT,
  category_key TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT,
  batch_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_runs (
  id TEXT PRIMARY KEY,
  week_key TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  progress_json TEXT,
  state_json TEXT,
  changes_json TEXT,
  proposals_json TEXT,
  report_md TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS category_summaries (
  category_key TEXT PRIMARY KEY,
  content_md TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category_l1, category_l2);
CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(deleted_at);
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_entry ON notes(entry_id);
CREATE INDEX IF NOT EXISTS idx_events_batch ON events(batch_id);
CREATE INDEX IF NOT EXISTS idx_events_entry ON events(entry_id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_key);
CREATE INDEX IF NOT EXISTS idx_weekly_week ON weekly_runs(week_key);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
`;

export function getDb() {
  if (db) return db;
  const config = loadConfig();
  const dir = dataDir(config);
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'kb.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  db.exec(SCHEMA_SQL);
  ensureColumn(db, 'entries', 'processing_mode', "TEXT NOT NULL DEFAULT 'full'");
  seedCategories(config);
  setMetaIfMissing('schema_version', '1');
  return db;
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function tx(fn) {
  const database = getDb();
  if (inTransaction) return fn(database);
  database.exec('BEGIN IMMEDIATE');
  inTransaction = true;
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    inTransaction = false;
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function seedCategories(config = loadConfig()) {
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO categories
      (key, level, parent_key, name, description, status, created_by, sort_order, created_at, updated_at)
    VALUES (?, 1, NULL, ?, ?, 'active', 'system', ?, ?, ?)
  `);
  const now = nowIso();
  config.categories.forEach((category, index) => {
    insert.run(category.key, category.name, category.description || '', index, now, now);
  });
  if (!database.prepare('SELECT key FROM categories WHERE key = ?').get('inbox')) {
    insert.run('inbox', '待归类', '暂时无法确定分类的内容', 9999, now, now);
  }
}

export function getMeta(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function setMetaIfMissing(key, value) {
  getDb().prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}
