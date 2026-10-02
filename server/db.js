// Real database: SQLite through Node's built-in node:sqlite. No external service.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.CLEANROUTE_DATA || join(here, '..', 'data')
export const DB_PATH = join(DATA_DIR, 'cleanroute.db')

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_points (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  landmark TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  ward TEXT NOT NULL,
  area_type TEXT NOT NULL,
  type TEXT NOT NULL,
  base_fill_rate REAL NOT NULL,
  estimated_level REAL NOT NULL DEFAULT 0,
  last_emptied_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expected_load_kg REAL NOT NULL DEFAULT 120,
  created_at TEXT NOT NULL,
  note TEXT,
  node_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_points_ward ON collection_points(ward);
CREATE INDEX IF NOT EXISTS idx_points_status ON collection_points(status);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id TEXT NOT NULL REFERENCES collection_points(id),
  device_id TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_point ON reports(point_id);
CREATE INDEX IF NOT EXISTS idx_reports_device ON reports(device_id);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  trust REAL NOT NULL DEFAULT 0.5,
  first_seen TEXT NOT NULL,
  last_seen TEXT,
  reports INTEGER NOT NULL DEFAULT 0,
  flagged TEXT
);

CREATE TABLE IF NOT EXISTS trucks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plate TEXT NOT NULL,
  capacity_kg REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  driver_id TEXT,
  home_node TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin TEXT NOT NULL,
  truck_id TEXT
);

CREATE TABLE IF NOT EXISTS operators (
  email TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stops (
  id TEXT PRIMARY KEY,
  route_id TEXT,
  truck_id TEXT NOT NULL REFERENCES trucks(id),
  point_id TEXT NOT NULL REFERENCES collection_points(id),
  stop_order INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  action_note TEXT,
  arrived_at TEXT,
  km_at_stop REAL
);
CREATE INDEX IF NOT EXISTS idx_stops_truck ON stops(truck_id, stop_order);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  truck_id TEXT NOT NULL REFERENCES trucks(id),
  day TEXT NOT NULL,
  km REAL NOT NULL,
  minutes INTEGER NOT NULL,
  solver TEXT,
  exact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS road_nodes (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS road_edges (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  km REAL,
  name TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ward TEXT NOT NULL DEFAULT 'all',
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1.2,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id TEXT NOT NULL,
  at TEXT NOT NULL,
  predicted_level REAL NOT NULL,
  predicted_hours REAL,
  actual_hours REAL,
  error_hours REAL,
  outcome TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_pred_point ON prediction_log(point_id);

CREATE TABLE IF NOT EXISTS action_queue (
  action_id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS pickups (
  id TEXT PRIMARY KEY,
  point_id TEXT,
  custodian_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  ward TEXT,
  needed_by TEXT NOT NULL,
  kind TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  message TEXT NOT NULL
);
`

let db = null

/**
 * Columns added after the first release. Existing databases keep their data.
 */
const MIGRATIONS = [
  ['reports', 'photo', 'TEXT'],
  ['reports', 'photo_note', 'TEXT'],
]

export function getDb() {
  if (db) return db
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec(SCHEMA)
  migrate()
  return db
}

function migrate() {
  for (const [table, column, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
}

export function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params)
}

export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params)
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params)
}

export function tx(fn) {
  const d = getDb()
  d.exec('BEGIN')
  try {
    const out = fn(d)
    d.exec('COMMIT')
    return out
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

export function wipe() {
  // Children before parents, so this is safe even inside the seeding transaction
  // (SQLite ignores PRAGMA foreign_keys while a transaction is open).
  const tables = [
    'action_queue', 'pickups', 'prediction_log', 'stops', 'routes', 'reports',
    'collection_points', 'devices', 'trucks', 'drivers', 'operators',
    'road_nodes', 'road_edges', 'places', 'events', 'settings', 'meta', 'activity',
  ]
  const d = getDb()
  for (const t of tables) d.exec(`DELETE FROM ${t}`)
  d.exec("DELETE FROM sqlite_sequence WHERE name IN ('reports','prediction_log','activity')")
}

/** Monotonic version counter so pollers can skip unchanged payloads. */
export function bumpVersion() {
  const row = get('SELECT value FROM meta WHERE key = ?', ['version'])
  const next = String((row ? Number(row.value) : 0) + 1)
  run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [
    'version',
    next,
  ])
  return Number(next)
}

export function version() {
  const row = get('SELECT value FROM meta WHERE key = ?', ['version'])
  return row ? Number(row.value) : 0
}

export function logActivity(kind, message, actor = null) {
  run('INSERT INTO activity(at,kind,actor,message) VALUES(?,?,?,?)', [
    new Date().toISOString(),
    kind,
    actor,
    message,
  ])
  const cut = new Date(Date.now() - 7 * 864e5).toISOString()
  run('DELETE FROM activity WHERE at < ?', [cut])
}

export function settings() {
  const rows = all('SELECT key, value FROM settings')
  const out = {}
  for (const r of rows) out[r.key] = Number(r.value)
  return out
}

export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [
    key,
    String(value),
  ])
}