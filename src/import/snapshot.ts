/**
 * Imports a redacted snapshot file instead of calling Google.
 *
 * This exists so Phase 0 is useful on day one: the audit runs, the catalog
 * fills and the schema gets exercised before anyone sets up a service account.
 * Once `npm run sync` works, the live pull replaces this.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SNAPSHOTS_DIR, type ClientConfig } from '../config.ts';
import { importRows, type ImportRow, type ImportStats } from './rows.ts';
import { log } from '../util/log.ts';

interface SnapshotFile {
  client: string;
  sheetId?: string;
  pulledAt?: string;
  rows: ImportRow[];
}

/** Newest snapshot for a client, by filename date. */
export function latestSnapshotPath(clientId: string): string | null {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.startsWith(`${clientId}-`) && f.endsWith('.json'))
    .sort();
  const last = files.at(-1);
  return last ? resolve(SNAPSHOTS_DIR, last) : null;
}

export function importSnapshot(cfg: ClientConfig, path?: string): ImportStats {
  const file = path ? resolve(path) : latestSnapshotPath(cfg.id);
  if (!file || !existsSync(file)) {
    throw new Error(
      `No snapshot found for client "${cfg.id}" in ${SNAPSHOTS_DIR}.\n` +
        'Either pass a path, or run `npm run sync` to pull the live sheet.',
    );
  }

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SnapshotFile;
  if (parsed.client && parsed.client !== cfg.id) {
    throw new Error(`Snapshot ${file} belongs to client "${parsed.client}", not "${cfg.id}".`);
  }
  if (!Array.isArray(parsed.rows)) {
    throw new Error(`Snapshot ${file} has no rows array.`);
  }

  log.info(`importing ${parsed.rows.length} rows from ${file}`);
  // Snapshots never carry plaintext passwords, by design.
  return importRows(cfg, parsed.rows, { plaintextPasswords: false });
}
