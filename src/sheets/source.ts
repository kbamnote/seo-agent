/**
 * Reads the team's existing manual tracker. Strictly read-only — the agent
 * never writes into the sheet five people are editing by hand.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHEET_TAB_TO_TYPE, SNAPSHOTS_DIR } from '../config.ts';
import { log } from '../util/log.ts';
import { passwordProblems } from '../util/vault.ts';
import { sheetsApi, explainSheetError } from './auth.ts';
import { isBlankRow, toRawRow, type RawRow } from './schema.ts';

export interface SourcePull {
  sheetId: string;
  pulledAt: string;
  tabs: string[];
  unknownTabs: string[];
  rows: RawRow[];
}

export async function pullSourceSheet(sheetId: string): Promise<SourcePull> {
  const api = sheetsApi();

  let titles: string[];
  try {
    const meta = await api.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties.title',
    });
    titles = (meta.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));
  } catch (err) {
    throw new Error(explainSheetError(err, sheetId));
  }

  const known = titles.filter((t) => t in SHEET_TAB_TO_TYPE);
  const unknownTabs = titles.filter((t) => !(t in SHEET_TAB_TO_TYPE));

  if (known.length === 0) {
    throw new Error(
      `None of the tabs in ${sheetId} match a known submission type.\n` +
        `Found: ${titles.join(', ')}\n` +
        'Add the tab name to SHEET_TAB_TO_TYPE in src/config.ts.',
    );
  }

  // A2:J skips the header row; row numbers are restored below so findings can
  // point a human at the exact cell.
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId: sheetId,
    ranges: known.map((t) => `'${t.replace(/'/g, "''")}'!A2:J`),
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows: RawRow[] = [];
  (res.data.valueRanges ?? []).forEach((range, i) => {
    const tab = known[i]!;
    (range.values ?? []).forEach((cells, idx) => {
      const row = toRawRow(tab, idx + 2, cells as unknown[]);
      if (!isBlankRow(row)) rows.push(row);
    });
  });

  log.info(`pulled ${rows.length} rows from ${known.length} tabs`);
  if (unknownTabs.length) log.warn(`ignored tabs: ${unknownTabs.join(', ')}`);

  return { sheetId, pulledAt: new Date().toISOString(), tabs: known, unknownTabs, rows };
}

/**
 * Writes a snapshot of a pull to data/snapshots/, with every password replaced
 * by its hygiene verdict. The snapshot is for diffing and for running the audit
 * offline; it must never become another copy of the credential leak it is
 * reporting on.
 */
export function saveSnapshot(clientId: string, pull: SourcePull): string {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const path = resolve(SNAPSHOTS_DIR, `${clientId}-${pull.pulledAt.slice(0, 10)}.json`);

  const redacted = {
    client: clientId,
    sheetId: pull.sheetId,
    pulledAt: pull.pulledAt,
    note: 'Passwords are redacted by design. Secrets live only in the encrypted vault in data/agent.db.',
    tabs: pull.tabs,
    rows: pull.rows.map((r) => ({
      ...r,
      password: r.password ? '[redacted]' : '',
      passwordHygiene: r.password ? passwordProblems(r.password, r.username) : [],
    })),
  };

  writeFileSync(path, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
  log.info(`snapshot → ${path}`);
  return path;
}
