/**
 * Imports tracker rows into the agent's own tables.
 *
 * Deliberate decision: an imported row never arrives as `verified`, whatever
 * the sheet claims. The sheet has rows marked Approved with no URL at all —
 * "Approved" in this data means "a human typed Approved", not "a link exists".
 * Phase 4's verifier is the only thing allowed to set `verified`.
 */

import type { ClientConfig, SubmissionType } from '../config.ts';
import { SHEET_TAB_TO_TYPE } from '../config.ts';
import { all, get, run, tx } from '../db/index.ts';
import { parseSheetDate } from '../util/dates.ts';
import { encryptSecret, passwordProblems, vaultReady } from '../util/vault.ts';
import { domainOf, type RawRow } from '../sheets/schema.ts';
import { log } from '../util/log.ts';

export interface ImportStats {
  rows: number;
  inserted: number;
  updated: number;
  skipped: number;
  sitesCreated: number;
  accountsCreated: number;
  credentialsEncrypted: number;
  credentialFindings: number;
}

/** Lowercase, punctuation-free form, so "AI/ML course in nagpur" matches config. */
function normaliseKeyword(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function upsertClient(cfg: ClientConfig) {
  run(
    `INSERT INTO clients (id, name, site_url, niche, city, country, contact_email,
                          contact_phone, source_sheet_id, agent_sheet_id, config_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       site_url = excluded.site_url,
       niche = excluded.niche,
       city = excluded.city,
       country = excluded.country,
       contact_email = excluded.contact_email,
       contact_phone = excluded.contact_phone,
       source_sheet_id = excluded.source_sheet_id,
       config_json = excluded.config_json,
       updated_at = datetime('now')`,
    cfg.id,
    cfg.name,
    cfg.siteUrl,
    cfg.niche ?? null,
    cfg.city ?? null,
    cfg.country ?? null,
    cfg.contact?.email ?? null,
    cfg.contact?.phone ?? null,
    cfg.sourceSheetId ?? null,
    cfg.agentSheetId ?? null,
    JSON.stringify(cfg),
  );
}

function upsertKeywords(cfg: ClientConfig) {
  for (const k of cfg.keywords) {
    run(
      `INSERT INTO keywords (client_id, keyword, target_url, priority, anchors_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(client_id, keyword) DO UPDATE SET
         target_url = excluded.target_url,
         priority = excluded.priority,
         anchors_json = excluded.anchors_json`,
      cfg.id,
      k.keyword,
      k.targetUrl,
      k.priority ?? 3,
      k.anchors ? JSON.stringify(k.anchors) : null,
    );
  }
}

function keywordIndex(clientId: string) {
  const rows = all<{ id: number; keyword: string }>(
    'SELECT id, keyword FROM keywords WHERE client_id = ?',
    clientId,
  );
  const index = new Map<string, number>();
  for (const r of rows) index.set(normaliseKeyword(r.keyword), r.id);
  return index;
}

/**
 * Matches a sheet keyword to a configured one. The sheet writes the same
 * keyword four ways ("Data Analysis Course", "Data Analysis Courses in Nagpur",
 * "Data Analysis Course – Learn Analytics with Real-World Projects"), so an
 * exact match is not enough: fall back to the longest configured keyword whose
 * words are all present.
 */
function matchKeyword(index: Map<string, number>, text: string): number | null {
  const norm = normaliseKeyword(text);
  if (!norm) return null;
  const exact = index.get(norm);
  if (exact) return exact;

  let best: { id: number; score: number } | null = null;
  for (const [key, id] of index) {
    const words = key.split(' ');
    const hits = words.filter((w) => norm.includes(w)).length;
    const score = hits / words.length;
    if (score >= 0.6 && (!best || score > best.score)) best = { id, score };
  }
  return best?.id ?? null;
}

function upsertSite(url: string, type: SubmissionType, stats: ImportStats): number | null {
  const domain = domainOf(url);
  if (!domain) return null;

  const existing = get<{ id: number; categories: string | null }>(
    'SELECT id, categories FROM sites WHERE domain = ?',
    domain,
  );

  if (existing) {
    const cats = new Set<string>(JSON.parse(existing.categories || '[]'));
    if (!cats.has(type)) {
      cats.add(type);
      run('UPDATE sites SET categories = ? WHERE id = ?', JSON.stringify([...cats]), existing.id);
    }
    return existing.id;
  }

  const res = run(
    `INSERT INTO sites (domain, name, home_url, categories, status, discovered_via, requires_account)
     VALUES (?, ?, ?, ?, 'active', 'source-sheet-import', 1)`,
    domain,
    domain,
    /^https?:\/\//i.test(url) ? url : `https://${domain}`,
    JSON.stringify([type]),
  );
  stats.sitesCreated++;
  return Number(res.lastInsertRowid);
}

function upsertAccount(
  clientId: string,
  siteId: number,
  row: RawRow,
  opts: { plaintextPasswords: boolean },
  stats: ImportStats,
): number | null {
  const username = row.username || row.email;
  if (!username) return null;

  const existing = get<{ id: number; secret_enc: string | null }>(
    'SELECT id, secret_enc FROM accounts WHERE client_id = ? AND site_id = ? AND username = ?',
    clientId,
    siteId,
    username,
  );

  let secret: string | null = null;
  if (opts.plaintextPasswords && row.password && row.password !== '[redacted]') {
    if (vaultReady()) {
      secret = encryptSecret(row.password);
      stats.credentialsEncrypted++;
    } else {
      log.warn('VAULT_KEY not set — passwords were read but not stored. Set it and re-run.');
    }
  }

  if (existing) {
    if (secret && !existing.secret_enc) {
      run('UPDATE accounts SET secret_enc = ? WHERE id = ?', secret, existing.id);
    }
    return existing.id;
  }

  const res = run(
    `INSERT INTO accounts (client_id, site_id, email, username, secret_enc, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    clientId,
    siteId,
    row.email || null,
    username,
    secret,
    secret ? 'active' : 'unverified',
    secret ? 'imported from source tracker' : 'imported without password — re-enter or rotate',
  );
  stats.accountsCreated++;
  return Number(res.lastInsertRowid);
}

export interface ImportRow extends RawRow {
  passwordHygiene?: string[];
}

export function importRows(
  cfg: ClientConfig,
  rows: ImportRow[],
  opts: { plaintextPasswords: boolean },
): ImportStats {
  const stats: ImportStats = {
    rows: rows.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    sitesCreated: 0,
    accountsCreated: 0,
    credentialsEncrypted: 0,
    credentialFindings: 0,
  };

  return tx(() => {
    upsertClient(cfg);
    upsertKeywords(cfg);
    const keywords = keywordIndex(cfg.id);

    // Credential findings are recomputed on every import; structural findings
    // belong to the audit and are left alone here.
    run("DELETE FROM findings WHERE client_id = ? AND code LIKE 'cred_%'", cfg.id);

    for (const row of rows) {
      const type = SHEET_TAB_TO_TYPE[row.tab];
      if (!type) {
        stats.skipped++;
        continue;
      }

      const siteId = upsertSite(row.platformUrl || row.backlink, type, stats);
      const accountId = siteId ? upsertAccount(cfg.id, siteId, row, opts, stats) : null;
      const keywordId = matchKeyword(keywords, row.keywords);
      const date = parseSheetDate(row.date);

      // An imported row is only ever 'submitted' (a URL exists to check later)
      // or 'unverifiable' (there is nothing to check at all).
      const status = row.backlink ? 'submitted' : 'unverifiable';

      const existing = get<{ id: number }>(
        `SELECT id FROM submissions
         WHERE client_id = ? AND source = 'source-sheet-import' AND source_tab = ? AND source_row = ?`,
        cfg.id,
        row.tab,
        row.rowNumber,
      );

      if (existing) {
        run(
          `UPDATE submissions SET
             site_id = ?, keyword_id = ?, account_id = ?, platform_url = ?, submitted_url = ?,
             keyword_text = ?, status = ?, source_status = ?, source_date_raw = ?,
             operator = ?, submitted_at = ?, updated_at = datetime('now')
           WHERE id = ?`,
          siteId,
          keywordId,
          accountId,
          row.platformUrl || null,
          row.backlink || null,
          row.keywords || null,
          status,
          row.status || null,
          row.date || null,
          row.name || null,
          date.iso,
          existing.id,
        );
        stats.updated++;
      } else {
        run(
          `INSERT INTO submissions
             (client_id, site_id, keyword_id, account_id, type, platform_url, submitted_url,
              keyword_text, status, source_status, source_date_raw, operator, source,
              source_tab, source_row, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'source-sheet-import', ?, ?, ?)`,
          cfg.id,
          siteId,
          keywordId,
          accountId,
          type,
          row.platformUrl || null,
          row.backlink || null,
          row.keywords || null,
          status,
          row.status || null,
          row.date || null,
          row.name || null,
          row.tab,
          row.rowNumber,
          date.iso,
        );
        stats.inserted++;
      }

      // Credential hygiene — from the plaintext if we have it, otherwise from
      // the verdict the snapshot recorded when it did.
      const problems =
        opts.plaintextPasswords && row.password && row.password !== '[redacted]'
          ? passwordProblems(row.password, row.username)
          : (row.passwordHygiene ?? []);

      if (problems.length) {
        run(
          `INSERT INTO findings (client_id, severity, code, message, detail)
           VALUES (?, 'high', 'cred_weak', ?, ?)`,
          cfg.id,
          `Weak or guessable password for ${row.username || row.email || 'account'} on ${
            row.platformUrl || row.tab
          }`,
          JSON.stringify({ tab: row.tab, row: row.rowNumber, problems }),
        );
        stats.credentialFindings++;
      }
    }

    return stats;
  });
}
