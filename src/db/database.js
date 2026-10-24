import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

let db = null;

export async function initDatabase() {
  const dbDir = path.dirname(CONFIG.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // 1. Try better-sqlite3 first
  try {
    const { default: Database } = await import('better-sqlite3');
    const rawDb = new Database(CONFIG.DB_PATH);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('synchronous = NORMAL');
    rawDb.pragma('foreign_keys = ON');

    db = {
      prepare: (sql) => {
        const stmt = rawDb.prepare(sql);
        return {
          get: (...params) => stmt.get(...params),
          all: (...params) => stmt.all(...params),
          run: (...params) => stmt.run(...params),
        };
      },
      exec: (sql) => rawDb.exec(sql),
      transaction: (fn) => rawDb.transaction(fn),
    };
    console.log('[Database] Connected via better-sqlite3 (WAL mode)');
  } catch (err) {
    // 2. Fallback to node:sqlite (Built-in Node 22+)
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const rawDb = new DatabaseSync(CONFIG.DB_PATH);
      rawDb.exec('PRAGMA journal_mode = WAL;');
      rawDb.exec('PRAGMA synchronous = NORMAL;');
      rawDb.exec('PRAGMA foreign_keys = ON;');

      db = {
        prepare: (sql) => {
          const stmt = rawDb.prepare(sql);
          return {
            get: (...params) => stmt.get(...params),
            all: (...params) => stmt.all(...params),
            run: (...params) => stmt.run(...params),
          };
        },
        exec: (sql) => rawDb.exec(sql),
        transaction: (fn) => (...args) => {
          rawDb.exec('BEGIN TRANSACTION;');
          try {
            const res = fn(...args);
            rawDb.exec('COMMIT;');
            return res;
          } catch (e) {
            rawDb.exec('ROLLBACK;');
            throw e;
          }
        },
      };
      console.log('[Database] Connected via Node.js built-in node:sqlite (WAL mode)');
    } catch (e2) {
      console.error('[Database Error] Failed to initialize SQLite engine', err, e2);
      throw new Error('No SQLite driver available. Please install better-sqlite3 or run on Node.js 22+');
    }
  }

  createSchema();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

function createSchema() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      license_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNCLAIMED',
      term TEXT NOT NULL DEFAULT '1m',
      days INTEGER,
      device_limit INTEGER NOT NULL DEFAULT 2,
      max_regenerations INTEGER NOT NULL DEFAULT 3,
      regenerations_used INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT,
      admin_notes TEXT,
      activated_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL,
      user_id TEXT,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      fingerprint TEXT,
      ip TEXT,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(license_id) REFERENCES licenses(id) ON DELETE CASCADE,
      UNIQUE(license_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      license_id TEXT,
      user_id TEXT,
      email TEXT,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bug_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      license_key TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      diagnostics TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      ip TEXT,
      license_key TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
    CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);
    CREATE INDEX IF NOT EXISTS idx_devices_devid ON devices(device_id);
    CREATE INDEX IF NOT EXISTS idx_magic_token ON magic_links(token);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
  `;

  db.exec(schema);
  console.log('[Database] Schema verified & tables ready.');
}
