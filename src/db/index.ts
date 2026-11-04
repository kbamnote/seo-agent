/**
 * SQLite access layer.
 *
 * Uses node:sqlite, the runtime's built-in driver (Node 24), so there is no
 * native module to compile — which on Windows is the difference between
 * `npm install` working and an afternoon lost to build tools.
 *
 * One connection per process, opened lazily and reused. Re-opening the handle
 * per call is a mistake this codebase has paid for elsewhere.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../util/log.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '../..');
export const DB_PATH = process.env.AGENT_DB_PATH
  ? resolve(process.env.AGENT_DB_PATH)
  : resolve(PROJECT_ROOT, 'data/agent.db');

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  handle = new DatabaseSync(DB_PATH);
  handle.exec('PRAGMA foreign_keys = ON;');
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** Applies schema.sql. Safe to run repeatedly — every statement is IF NOT EXISTS. */
export function initSchema(): void {
  const sql = readFileSync(resolve(here, 'schema.sql'), 'utf8');
  db().exec(sql);
  migrate();
  log.debug(`schema applied → ${DB_PATH}`);
}

/**
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
 * columns added to schema.sql after a database was created need an ALTER. This
 * adds any that are missing; it is the whole migration story for a single-file
 * local database.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['submissions', 'source_status', 'TEXT'],
  ['submissions', 'source_date_raw', 'TEXT'],
  ['sites', 'http_status', 'INTEGER'],
  ['sites', 'final_url', 'TEXT'],
  ['sites', 'robots_allowed', 'INTEGER'],
  ['sites', 'signals_json', 'TEXT'],
  ['sites', 'nofollow_ratio', 'REAL'],
  ['sites', 'external_links', 'INTEGER'],
  ['sites', 'captcha_vendor', 'TEXT'],
  ['sites', 'language', 'TEXT'],
  ['sites', 'blocklisted', 'INTEGER NOT NULL DEFAULT 0'],
  ['content_items', 'generator', 'TEXT'],
  ['content_items', 'word_count', 'INTEGER'],
  ['content_items', 'variation', 'INTEGER NOT NULL DEFAULT 1'],
  ['content_items', 'site_id', 'INTEGER'],
];

function migrate(): void {
  const d = db();
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.length) continue; // table not created yet
    if (cols.some((c) => c.name === column)) continue;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    log.info(`migrated: ${table}.${column} added`);
  }
}

// ── Small query helpers ──────────────────────────────────────────────────────
// node:sqlite takes positional parameters, which keeps the call sites honest.

type Param = string | number | bigint | null | Uint8Array;

export function run(sql: string, ...params: Param[]) {
  return db().prepare(sql).run(...params);
}

export function all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

/** Wraps fn in a transaction; rolls back on any throw. */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* a failed rollback must not mask the original error */
    }
    throw err;
  }
}

/** Opens a row in `runs`, and returns a finisher to close it either way. */
export function startRun(kind: string, clientId?: string | null) {
  const res = run('INSERT INTO runs (kind, client_id) VALUES (?, ?)', kind, clientId ?? null);
  const id = Number(res.lastInsertRowid);
  return {
    id,
    finish(stats: unknown, status = 'ok') {
      run(
        "UPDATE runs SET finished_at = datetime('now'), status = ?, stats_json = ? WHERE id = ?",
        status,
        JSON.stringify(stats ?? {}),
        id,
      );
    },
    fail(err: unknown) {
      run(
        "UPDATE runs SET finished_at = datetime('now'), status = 'error', error = ? WHERE id = ?",
        String(err instanceof Error ? err.message : err).slice(0, 2000),
        id,
      );
    },
  };
}
