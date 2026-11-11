import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,      -- one row per deal+transition: the duplicate-delivery guard
  hubspot_deal_id TEXT NOT NULL,
  status TEXT NOT NULL,                      -- pending|processing|succeeded|failed|needs_approval|needs_review|skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  deal_name TEXT, amount REAL, currency TEXT,
  qbo_customer_id TEXT, qbo_invoice_id TEXT, qbo_invoice_total REAL,
  last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (        -- append-only; never UPDATE or DELETE
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS customer_map (     -- HubSpot company/contact -> QBO customer
  hubspot_key TEXT PRIMARY KEY, qbo_customer_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (     -- encrypted blob, one row per QBO company
  realm_id TEXT PRIMARY KEY, env TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`);

export const audit = (eventId, actor, action, detail = {}) =>
  db.prepare('INSERT INTO audit_log(event_id, at, actor, action, detail) VALUES (?,?,?,?,?)')
    .run(eventId, Date.now(), actor, action, JSON.stringify(detail));
