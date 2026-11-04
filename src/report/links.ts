/**
 * The link report: what the client actually has.
 *
 * Every number here is backed by a verification record. "Submitted" is not a
 * result and does not appear as one — the headline figure is verified-live
 * links, because that is the only thing a client is really buying.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, all, get } from '../db/index.ts';
import { TYPE_VALUE_WEIGHT } from '../config.ts';
import { todayIso } from '../util/dates.ts';
import { log } from '../util/log.ts';
import { indexationReport } from '../indexing/indexnow.ts';

export interface LinkReport {
  totals: {
    all: number;
    verified: number;
    lost: number;
    waiting: number;
    unverifiable: number;
    /** Checked, but the platform refused us — honestly unknown either way. */
    blockedFromCheck: number;
    /** URL present as plain text rather than as a link. */
    mentionOnly: number;
  };
  dofollow: number;
  nofollow: number;
  byType: Array<{ type: string; verified: number; lost: number; waiting: number; weight: number }>;
  byStatusSource: Array<{ source: string; status: string; n: number }>;
  anchors: Array<{ kind: string; n: number }>;
  lostLinks: Array<{ id: number; domain: string | null; url: string; type: string }>;
  reportPath: string;
}

function count(clientId: string, where: string, ...params: Array<string | number>): number {
  return (
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND ${where}`, clientId, ...params)
      ?.n ?? 0
  );
}

/**
 * Counts submissions whose MOST RECENT verification note matches. Used for the
 * two states that are neither success nor failure: the platform blocked us, and
 * the URL is a text mention rather than a link.
 */
function latestNoteCount(clientId: string, like: string): number {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM submissions s
         JOIN verifications v ON v.id = (
              SELECT id FROM verifications w WHERE w.submission_id = s.id
               ORDER BY checked_at DESC, id DESC LIMIT 1)
        WHERE s.client_id = ? AND v.note LIKE ?`,
      clientId,
      like,
    )?.n ?? 0
  );
}

export function buildLinkReport(clientId: string): LinkReport {
  const totals = {
    all: count(clientId, '1 = 1'),
    verified: count(clientId, "status = 'verified'"),
    lost: count(clientId, "status = 'lost'"),
    waiting: count(clientId, "status IN ('submitted', 'needs_assist', 'manual_queue')"),
    unverifiable: count(clientId, "status = 'unverifiable'"),
    blockedFromCheck: latestNoteCount(clientId, '%refused us%'),
    mentionOnly: latestNoteCount(clientId, '%plain text%'),
  };

  const follow = all<{ rel: string | null; n: number }>(
    `SELECT v.rel, COUNT(*) AS n
       FROM submissions s
       JOIN verifications v ON v.id = (
            SELECT id FROM verifications w WHERE w.submission_id = s.id
             ORDER BY checked_at DESC, id DESC LIMIT 1)
      WHERE s.client_id = ? AND s.status = 'verified'
      GROUP BY v.rel`,
    clientId,
  );

  const dofollow = follow.find((f) => f.rel === 'dofollow')?.n ?? 0;
  const nofollow = follow.filter((f) => f.rel && f.rel !== 'dofollow').reduce((n, f) => n + f.n, 0);

  const types = all<{ type: string }>(
    'SELECT DISTINCT type FROM submissions WHERE client_id = ?',
    clientId,
  );

  const byType = types.map((t) => ({
    type: t.type,
    verified: count(clientId, "type = ? AND status = 'verified'", t.type),
    lost: count(clientId, "type = ? AND status = 'lost'", t.type),
    waiting: count(clientId, "type = ? AND status IN ('submitted','needs_assist','manual_queue')", t.type),
    weight: TYPE_VALUE_WEIGHT[t.type as keyof typeof TYPE_VALUE_WEIGHT] ?? 0,
  }));

  const byStatusSource = all<{ source: string; status: string; n: number }>(
    `SELECT source, status, COUNT(*) AS n FROM submissions
      WHERE client_id = ? GROUP BY source, status ORDER BY source, n DESC`,
    clientId,
  );

  const anchors = all<{ kind: string; n: number }>(
    `SELECT c.anchor_kind AS kind, COUNT(*) AS n
       FROM submissions s JOIN content_items c ON c.id = s.content_id
      WHERE s.client_id = ? AND s.status = 'verified' AND c.anchor_kind IS NOT NULL
      GROUP BY c.anchor_kind ORDER BY n DESC`,
    clientId,
  );

  const lostLinks = all<{ id: number; domain: string | null; url: string; type: string }>(
    `SELECT s.id, si.domain, s.submitted_url AS url, s.type
       FROM submissions s LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ? AND s.status = 'lost'
      ORDER BY s.updated_at DESC LIMIT 50`,
    clientId,
  );

  const report: LinkReport = {
    totals,
    dofollow,
    nofollow,
    byType,
    byStatusSource,
    anchors,
    lostLinks,
    reportPath: '',
  };
  report.reportPath = write(clientId, report);
  return report;
}

function write(clientId: string, r: LinkReport): string {
  const dir = resolve(PROJECT_ROOT, 'data/reports');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${clientId}-links-${todayIso()}.md`);
  const idx = indexationReport(clientId);

  const lines: string[] = [
    `# Link report — ${clientId}`,
    '',
    `Generated ${todayIso()}. Every figure below is backed by a verification record.`,
    '',
    '## Headline',
    '',
    `- **Verified live links: ${r.totals.verified}**`,
    `  - dofollow: ${r.dofollow}`,
    `  - nofollow / ugc / sponsored: ${r.nofollow}`,
    `- Lost (was there, now gone): ${r.totals.lost}`,
    `- Submitted, not yet confirmed: ${r.totals.waiting}`,
    `- Unverifiable (no URL was ever recorded): ${r.totals.unverifiable}`,
    `- Rows in total: ${r.totals.all}`,
    '',
    `**Honestly unknown: ${r.totals.blockedFromCheck}** — the platform returned 403 to both a`,
    'plain fetch and a rendered browser, so the link can be neither confirmed nor denied.',
    'These are not failures and not successes. Re-check them with `verify --session` on a',
    'machine where that platform is logged in, or look by hand.',
    '',
    `**Text mentions, not links: ${r.totals.mentionOnly}** — the URL appears as plain text on`,
    'the page with no anchor around it. These pass nothing at all.',
    '',
    '> "Submitted" is not a result. A link counts when a verifier has fetched the page',
    '> and found it.',
    '',
  ];

  if (idx.checked) {
    lines.push('## Indexation of verified links', '');
    lines.push(`- Indexed: ${idx.indexed} of ${idx.checked}`);
    lines.push(`- Not indexed: ${idx.notIndexed.length}`);
    lines.push(`- Not checked: ${idx.unknown}  _(run verify with --check-index)_`);
    if (idx.notIndexed.length) {
      lines.push('', 'A backlink on a page that is not indexed passes nothing. These are candidates', 'for dropping the platform rather than fixing the link:', '');
      for (const n of idx.notIndexed.slice(0, 20)) {
        lines.push(`- ${n.domain ?? '?'} — ${n.days}d old — ${n.url}`);
      }
    }
    lines.push('');
  }

  lines.push('## By submission type', '');
  lines.push('| Type | Verified | Lost | Waiting | Link value |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const t of [...r.byType].sort((a, b) => b.weight - a.weight)) {
    lines.push(`| ${t.type} | ${t.verified} | ${t.lost} | ${t.waiting} | ${t.weight.toFixed(2)} |`);
  }
  lines.push('');

  if (r.anchors.length) {
    const total = r.anchors.reduce((n, a) => n + a.n, 0);
    lines.push('## Anchor profile of verified links', '');
    lines.push('| Kind | Count | Share |');
    lines.push('|---|---:|---:|');
    for (const a of r.anchors) {
      lines.push(`| ${a.kind} | ${a.n} | ${Math.round((a.n / total) * 100)}% |`);
    }
    lines.push('');
  }

  lines.push('## Where the rows came from', '');
  lines.push('| Source | Status | Count |');
  lines.push('|---|---|---:|');
  for (const s of r.byStatusSource) {
    lines.push(`| ${s.source} | ${s.status} | ${s.n} |`);
  }
  lines.push('');

  if (r.lostLinks.length) {
    lines.push(`## Lost links (${r.lostLinks.length})`, '');
    for (const l of r.lostLinks) {
      lines.push(`- ${l.domain ?? '?'} (${l.type}) — ${l.url}`);
    }
    lines.push('');
  }

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  log.info(`report → ${path}`);
  return path;
}

export function printLinkReport(r: LinkReport) {
  log.heading('Links');
  console.log(`  verified live ......... ${r.totals.verified}  (dofollow ${r.dofollow}, nofollow ${r.nofollow})`);
  console.log(`  lost .................. ${r.totals.lost}`);
  console.log(`  awaiting confirmation . ${r.totals.waiting}`);
  console.log(`  unverifiable .......... ${r.totals.unverifiable}  (no URL ever recorded)`);
  console.log(`  honestly unknown ...... ${r.totals.blockedFromCheck}  (platform blocked the check)`);
  console.log(`  text mentions only .... ${r.totals.mentionOnly}  (no anchor — passes nothing)`);
  console.log(`  total rows ............ ${r.totals.all}`);
  console.log(`\n  full report: ${r.reportPath}\n`);
}
