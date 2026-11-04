/**
 * Site catalog queries and the console views over them.
 */

import { all, get, run } from '../db/index.ts';
import { TYPE_VALUE_WEIGHT, type SubmissionType } from '../config.ts';
import { scoreBand } from '../vetting/score.ts';
import { pickScore } from '../vetting/authority.ts';
import { log } from '../util/log.ts';

export interface CatalogFilter {
  type?: SubmissionType;
  status?: string;
  minScore?: number;
  limit?: number;
}

export interface CatalogRow {
  domain: string;
  name: string | null;
  categories: string | null;
  status: string;
  score: number | null;
  authority: number | null;
  manual_only: number;
  adapter: string | null;
  captcha_vendor: string | null;
  nofollow_ratio: number | null;
  external_links: number | null;
  reject_reason: string | null;
  discovered_via: string | null;
  vetted_at: string | null;
}

export function listSites(filter: CatalogFilter = {}): CatalogRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filter.type) {
    clauses.push('categories LIKE ?');
    params.push(`%"${filter.type}"%`);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.minScore !== undefined) {
    clauses.push('score >= ?');
    params.push(filter.minScore);
  }

  return all<CatalogRow>(
    `SELECT domain, name, categories, status, score, authority, manual_only, adapter, captcha_vendor,
            nofollow_ratio, external_links, reject_reason, discovered_via, vetted_at
       FROM sites
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY (score IS NULL),
               (0.45 * COALESCE(score, 0) + 0.55 * COALESCE(authority, 50)) DESC,
               domain
      LIMIT ?`,
    ...params,
    filter.limit ?? 50,
  );
}

export function printList(rows: CatalogRow[]) {
  if (!rows.length) {
    console.log('No sites match.');
    return;
  }
  console.log(
    `\n${'domain'.padEnd(32)}${'sub'.padStart(4)}${'auth'.padStart(6)}  ${'status'.padEnd(10)}${'flags'.padEnd(18)}categories`,
  );
  console.log('─'.repeat(104));
  for (const r of rows) {
    const flags = [
      r.manual_only ? 'manual' : '',
      r.adapter ? `adapter:${r.adapter}` : '',
      r.captcha_vendor ? 'captcha' : '',
    ]
      .filter(Boolean)
      .join(',');
    const cats = (JSON.parse(r.categories || '[]') as string[]).join(',');
    console.log(
      r.domain.slice(0, 31).padEnd(32) +
        String(r.score ?? '-').padStart(4) +
        String(r.authority ?? '-').padStart(6) +
        '  ' +
        r.status.padEnd(10) +
        flags.slice(0, 17).padEnd(18) +
        cats +
        (r.reject_reason ? `  (${r.reject_reason})` : ''),
    );
  }
  console.log(
    '\n  sub = submittability (can a machine post here)   auth = authority (is a link from here worth having)\n' +
      '  sorted by 0.45*sub + 0.55*auth; unknown authority counts as 50\n',
  );
}

export function showSite(domain: string) {
  const key = domain.toLowerCase().replace(/^www\./, '');
  const row = get<CatalogRow & { signals_json: string | null; home_url: string; submit_url: string | null; notes: string | null; final_url: string | null; http_status: number | null; robots_allowed: number | null; language: string | null }>(
    `SELECT domain, name, categories, status, score, authority, manual_only, adapter, captcha_vendor,
            nofollow_ratio, external_links, reject_reason, discovered_via, vetted_at,
            signals_json, home_url, submit_url, notes, final_url, http_status, robots_allowed, language
       FROM sites WHERE domain = ?`,
    key,
  );
  if (!row) {
    console.log(`${key} is not in the catalog.`);
    return;
  }

  log.heading(`${row.domain}${row.name && row.name !== row.domain ? ` — ${row.name}` : ''}`);
  const cats = JSON.parse(row.categories || '[]') as SubmissionType[];
  console.log(`  status ........... ${row.status}${row.reject_reason ? ` (${row.reject_reason})` : ''}`);
  console.log(
    `  submittability ... ${row.score ?? '-'}${row.score !== null ? ` (${scoreBand(row.score)})` : ''}`,
  );
  console.log(`  authority ........ ${row.authority ?? '-'}`);
  console.log(`  categories ....... ${cats.join(', ') || '-'}`);
  if (cats.length) {
    const best = Math.max(...cats.map((c) => TYPE_VALUE_WEIGHT[c] ?? 0));
    const bestType = cats.find((c) => (TYPE_VALUE_WEIGHT[c] ?? 0) === best);
    console.log(`  category weight .. ${best.toFixed(2)} (${bestType})`);
    console.log(`  pick score ....... ${pickScore(row.score, row.authority, best)}`);
  }
  console.log(`  home ............. ${row.home_url}`);
  if (row.final_url && row.final_url !== row.home_url) console.log(`  resolves to ...... ${row.final_url}`);
  if (row.submit_url) console.log(`  submit ........... ${row.submit_url}`);
  console.log(`  http ............. ${row.http_status ?? '-'}`);
  console.log(`  robots ........... ${row.robots_allowed === null ? '-' : row.robots_allowed ? 'allowed' : 'disallowed'}`);
  console.log(`  language ......... ${row.language ?? '-'}`);
  console.log(`  outbound links ... ${row.external_links ?? '-'}`);
  console.log(`  nofollow ratio ... ${row.nofollow_ratio ?? '-'}`);
  console.log(`  captcha .......... ${row.captcha_vendor ?? 'none seen'}`);
  console.log(`  adapter .......... ${row.adapter ?? 'generic form filler'}`);
  console.log(`  automation ....... ${row.manual_only ? 'manual only (terms forbid automation)' : 'automatable'}`);
  console.log(`  found via ........ ${row.discovered_via ?? '-'}`);
  console.log(`  vetted ........... ${row.vetted_at ?? 'never'}`);
  if (row.notes) console.log(`\n  note: ${row.notes}`);

  if (row.signals_json) {
    try {
      const parsed = JSON.parse(row.signals_json) as { reasons?: string[]; signals?: Record<string, unknown> };
      if (parsed.reasons?.length) {
        console.log('\n  score breakdown:');
        for (const reason of parsed.reasons) console.log(`    ${reason}`);
      }
      const s = parsed.signals as Record<string, unknown> | undefined;
      if (s) {
        console.log('\n  observed:');
        console.log(`    submission entry points: ${(s.submitCandidates as string[])?.length ?? 0}`);
        console.log(`    forms ${s.formCount}, textarea ${s.hasTextarea}, file input ${s.hasFileInput}, url field ${s.hasUrlField}`);
        for (const u of ((s.submitCandidates as string[]) ?? []).slice(0, 5)) console.log(`      ${u}`);
      }
    } catch {
      /* signals are advisory */
    }
  }
  console.log('');
}

export function catalogStats() {
  const byStatus = all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM sites GROUP BY status ORDER BY n DESC',
  );
  const byReject = all<{ status: string; reason: string; n: number }>(
    `SELECT status,
            CASE WHEN length(reject_reason) > 40
                 THEN substr(reject_reason, 1, 37) || '...'
                 ELSE reject_reason END AS reason,
            COUNT(*) AS n
       FROM sites
      WHERE reject_reason IS NOT NULL AND status IN ('rejected', 'blocked')
      GROUP BY status, reason
      ORDER BY status, n DESC`,
  );
  // json_each is available in SQLite's default build, but a count per type via
  // LIKE is cheap and cannot fail, so it backs the nicer query up.
  let usable: Array<{ cat: string; n: number }>;
  try {
    usable = all<{ cat: string; n: number }>(
      // NB: json_each exposes its own column called "type" (the JSON datatype),
      // which shadows an alias of that name — group by the aliased value, not
      // by "type", or every row lands in one bucket.
      `SELECT json_each.value AS cat, COUNT(*) AS n
         FROM sites, json_each(sites.categories)
        WHERE sites.status = 'vetted' AND sites.score >= 60
        GROUP BY json_each.value ORDER BY n DESC`,
    );
  } catch {
    usable = Object.keys(TYPE_VALUE_WEIGHT)
      .map((cat) => ({
        cat,
        n:
          get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM sites
              WHERE status = 'vetted' AND score >= 60 AND categories LIKE ?`,
            `%"${cat}"%`,
          )?.n ?? 0,
      }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);
  }
  const captcha = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sites WHERE captcha_vendor IS NOT NULL AND status = 'vetted'",
  );
  const manual = get<{ n: number }>("SELECT COUNT(*) AS n FROM sites WHERE manual_only = 1");

  log.heading('Catalog');
  for (const r of byStatus) console.log(`  ${r.status.padEnd(12)} ${String(r.n).padStart(4)}`);
  console.log(`\n  usable (vetted, score >= 60) by type:`);
  if (!usable.length) console.log('    none yet — run `npm run vet`');
  for (const r of usable) console.log(`    ${r.cat.padEnd(12)} ${String(r.n).padStart(4)}`);
  if (byReject.length) {
    console.log(`\n  set aside:`);
    for (const r of byReject) {
      console.log(`    ${r.status.padEnd(9)} ${r.reason.padEnd(42)} ${String(r.n).padStart(3)}`);
    }
    console.log('    (blocked = our crawler was turned away; rejected = the site itself is no good)');
  }
  console.log(`\n  needing Assist Mode (captcha): ${captcha?.n ?? 0}`);
  console.log(`  manual-only (terms forbid automation): ${manual?.n ?? 0}\n`);
}

export function setSiteStatus(domain: string, status: string, reason?: string) {
  const key = domain.toLowerCase().replace(/^www\./, '');
  const flag = get<{ blocklisted: number }>('SELECT blocklisted FROM sites WHERE domain = ?', key);
  if (flag?.blocklisted && status !== 'rejected') {
    throw new Error(
      `${key} is blocklisted — it cannot carry a backlink at all. ` +
        'Remove it from config/seed-sites.json if that is genuinely wrong.',
    );
  }
  const res = run(
    'UPDATE sites SET status = ?, reject_reason = ? WHERE domain = ?',
    status,
    reason ?? null,
    key,
  );
  if (!res.changes) throw new Error(`${key} is not in the catalog.`);
  log.info(`${key} → ${status}${reason ? ` (${reason})` : ''}`);
}
