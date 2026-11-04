/**
 * Data-quality audit over the imported tracker.
 *
 * The point of this report is to answer one question before any new link is
 * built: of everything the sheet claims, what actually exists? It only makes
 * structural claims — "there is no URL here", "this URL is a whois page" — and
 * leaves "is the link live?" to the Phase 4 verifier, which has to fetch pages.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { all, PROJECT_ROOT, run, tx } from '../db/index.ts';
import { TYPE_VALUE_WEIGHT, type SubmissionType } from '../config.ts';
import { looksLikeDate, parseSheetDate, todayIso } from '../util/dates.ts';
import { log } from '../util/log.ts';

interface SubRow {
  id: number;
  type: SubmissionType;
  platform_url: string | null;
  submitted_url: string | null;
  keyword_text: string | null;
  keyword_id: number | null;
  status: string;
  source_status: string | null;
  source_date_raw: string | null;
  operator: string | null;
  source_tab: string | null;
  source_row: number | null;
  account_email: string | null;
}

interface Finding {
  submissionId: number | null;
  severity: 'high' | 'medium' | 'low';
  code: string;
  message: string;
  detail?: unknown;
}

/**
 * URLs that were recorded as backlinks but cannot be one: tool pages, lookup
 * services and search results. A link on one of these is not a link the client
 * owns, and no amount of waiting will make it count.
 */
const NOT_A_BACKLINK: Array<{ test: RegExp; why: string }> = [
  { test: /(^|\/\/|\.)whois\.com\//i, why: 'a whois lookup page — it carries no link you placed' },
  { test: /(^|\/\/|\.)who\.is\//i, why: 'a whois lookup page — it carries no link you placed' },
  { test: /backlink-maker|backlink_maker|backlinkmaker/i, why: 'an SEO tool page, not a published submission' },
  { test: /\/seo-tools?\//i, why: 'an SEO tool page, not a published submission' },
  { test: /smallseotools|prepostseo|duplichecker/i, why: 'an SEO tool page, not a published submission' },
  { test: /(google|bing|duckduckgo)\.[a-z.]+\/search/i, why: 'a search results page' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function norm(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export interface AuditResult {
  total: number;
  withBacklink: number;
  unverifiable: number;
  claimedApprovedWithoutUrl: number;
  genuineCandidates: number;
  findings: Finding[];
  byType: Array<{ type: string; rows: number; withUrl: number; weight: number }>;
  reportPath: string;
}

export function auditClient(clientId: string): AuditResult {
  const rows = all<SubRow>(
    `SELECT s.id, s.type, s.platform_url, s.submitted_url, s.keyword_text, s.keyword_id,
            s.status, s.source_status, s.source_date_raw, s.operator, s.source_tab, s.source_row,
            a.email AS account_email
       FROM submissions s
       LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.client_id = ? AND s.source = 'source-sheet-import'
      ORDER BY s.source_tab, s.source_row`,
    clientId,
  );

  if (rows.length === 0) {
    throw new Error(
      `No imported rows for client "${clientId}". Run \`npm run import:snapshot -- --client ${clientId}\` first.`,
    );
  }

  const findings: Finding[] = [];
  const seenBacklinks = new Map<string, SubRow>();
  const seenSiteKeyword = new Map<string, number>();

  let withBacklink = 0;
  let claimedApprovedWithoutUrl = 0;
  let notABacklink = 0;

  for (const r of rows) {
    const where = `${r.source_tab} row ${r.source_row}`;
    const backlink = (r.submitted_url || '').trim();
    const platform = (r.platform_url || '').trim();
    const claimed = (r.source_status || '').trim().toLowerCase();

    // ── No URL at all ────────────────────────────────────────────────────────
    if (!backlink) {
      if (claimed === 'approved') {
        claimedApprovedWithoutUrl++;
        findings.push({
          submissionId: r.id,
          severity: 'high',
          code: 'approved_without_url',
          message: `${where}: marked "Approved" but has no backlink URL — nothing to verify`,
          detail: { tab: r.source_tab, row: r.source_row, type: r.type },
        });
      } else {
        findings.push({
          submissionId: r.id,
          severity: 'medium',
          code: 'no_url',
          message: `${where}: no backlink URL recorded`,
          detail: { tab: r.source_tab, row: r.source_row, claimed: r.source_status },
        });
      }
    } else {
      withBacklink++;

      // ── Recorded URL cannot be a backlink ─────────────────────────────────
      const bad = NOT_A_BACKLINK.find((p) => p.test.test(backlink));
      if (bad) {
        notABacklink++;
        findings.push({
          submissionId: r.id,
          severity: 'high',
          code: 'not_a_backlink',
          message: `${where}: ${backlink} is ${bad.why}`,
          detail: { url: backlink },
        });
      }

      // ── Backlink is just the platform's own URL ───────────────────────────
      if (platform && norm(backlink) === norm(platform)) {
        findings.push({
          submissionId: r.id,
          severity: 'medium',
          code: 'backlink_is_platform',
          message: `${where}: the backlink is the platform's own URL, so no submission page was created`,
          detail: { url: backlink },
        });
      }

      // ── Duplicate backlink ────────────────────────────────────────────────
      const key = norm(backlink);
      const prior = seenBacklinks.get(key);
      if (prior) {
        findings.push({
          submissionId: r.id,
          severity: 'low',
          code: 'duplicate_backlink',
          message: `${where}: same URL already recorded at ${prior.source_tab} row ${prior.source_row}`,
          detail: { url: backlink },
        });
      } else {
        seenBacklinks.set(key, r);
      }
    }

    // ── Status column holding a date ──────────────────────────────────────────
    if (r.source_status && looksLikeDate(r.source_status)) {
      findings.push({
        submissionId: r.id,
        severity: 'high',
        code: 'status_is_date',
        message: `${where}: the Status column contains a date ("${r.source_status}") instead of a status`,
        detail: { value: r.source_status },
      });
    }

    // ── Unreadable or odd date ───────────────────────────────────────────────
    if (r.source_date_raw) {
      const parsed = parseSheetDate(r.source_date_raw);
      if (!parsed.ok) {
        findings.push({
          submissionId: r.id,
          severity: 'medium',
          code: 'bad_date',
          message: `${where}: date "${r.source_date_raw}" could not be read (${parsed.reason})`,
          detail: { raw: r.source_date_raw },
        });
      } else if (/[\/.\-]{2,}/.test(r.source_date_raw) || parsed.ambiguous) {
        findings.push({
          submissionId: r.id,
          severity: 'low',
          code: 'messy_date',
          message: `${where}: date "${r.source_date_raw}" is malformed or ambiguous; read as ${parsed.iso}`,
          detail: { raw: r.source_date_raw, iso: parsed.iso },
        });
      }
    }

    // ── Email column not holding an email ────────────────────────────────────
    if (r.account_email && !EMAIL_RE.test(r.account_email)) {
      findings.push({
        submissionId: r.id,
        severity: 'medium',
        code: 'bad_email',
        message: `${where}: "${r.account_email}" is in the Email id column but is not an email address`,
        detail: { value: r.account_email },
      });
    }

    // ── Keyword hygiene ─────────────────────────────────────────────────────
    if (!r.keyword_text) {
      findings.push({
        submissionId: r.id,
        severity: 'medium',
        code: 'no_keyword',
        message: `${where}: no keyword recorded, so the link has no target and no anchor`,
      });
    } else if (!r.keyword_id) {
      findings.push({
        submissionId: r.id,
        severity: 'low',
        code: 'keyword_unmapped',
        message: `${where}: keyword "${r.keyword_text}" does not match any keyword in the client config`,
        detail: { keyword: r.keyword_text },
      });
    }

    // ── Same platform hit twice for the same keyword ─────────────────────────
    if (platform && r.keyword_text) {
      const sk = `${norm(platform)}|${r.keyword_text.toLowerCase()}`;
      const count = (seenSiteKeyword.get(sk) ?? 0) + 1;
      seenSiteKeyword.set(sk, count);
      if (count > 1) {
        findings.push({
          submissionId: r.id,
          severity: 'low',
          code: 'repeat_site_keyword',
          message: `${where}: ${count}th submission to the same platform for the same keyword — diminishing value`,
          detail: { platform, keyword: r.keyword_text },
        });
      }
    }
  }

  // Credential findings came from the import step; keep them in the report.
  const credFindings = all<{ severity: string; code: string; message: string; detail: string | null }>(
    "SELECT severity, code, message, detail FROM findings WHERE client_id = ? AND code LIKE 'cred_%'",
    clientId,
  );

  // Persist structural findings, replacing the previous run's.
  tx(() => {
    run("DELETE FROM findings WHERE client_id = ? AND code NOT LIKE 'cred_%'", clientId);
    for (const f of findings) {
      run(
        `INSERT INTO findings (client_id, submission_id, severity, code, message, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        clientId,
        f.submissionId,
        f.severity,
        f.code,
        f.message,
        f.detail ? JSON.stringify(f.detail) : null,
      );
    }
  });

  const types = [...new Set(rows.map((r) => r.type))];
  const byType = types.map((t) => {
    const subset = rows.filter((r) => r.type === t);
    return {
      type: t,
      rows: subset.length,
      withUrl: subset.filter((r) => r.submitted_url).length,
      weight: TYPE_VALUE_WEIGHT[t] ?? 0,
    };
  });

  const result: AuditResult = {
    total: rows.length,
    withBacklink,
    unverifiable: rows.length - withBacklink,
    claimedApprovedWithoutUrl,
    genuineCandidates: withBacklink - notABacklink,
    findings,
    byType,
    reportPath: '',
  };

  result.reportPath = writeReport(clientId, result, credFindings);
  return result;
}

function writeReport(
  clientId: string,
  r: AuditResult,
  credFindings: Array<{ severity: string; code: string; message: string; detail: string | null }>,
): string {
  const dir = resolve(PROJECT_ROOT, 'data/reports');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${clientId}-audit-${todayIso()}.md`);

  const bySeverity = (sev: string) => r.findings.filter((f) => f.severity === sev);
  const counts = new Map<string, number>();
  for (const f of r.findings) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);

  const lines: string[] = [];
  lines.push(`# Off-page tracker audit — ${clientId}`);
  lines.push('');
  lines.push(`Generated ${todayIso()} from the imported source tracker.`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- Rows imported: **${r.total}**`);
  lines.push(`- Rows with a backlink URL: **${r.withBacklink}**`);
  lines.push(`- Rows with nothing to verify: **${r.unverifiable}**`);
  lines.push(`- Rows marked "Approved" with no URL: **${r.claimedApprovedWithoutUrl}**`);
  lines.push(`- URLs worth verifying against the live web: **${r.genuineCandidates}**`);
  lines.push('');
  lines.push('> No row is treated as a confirmed backlink by this report. It checks structure only;');
  lines.push('> whether a link is live, dofollow and indexed is settled by the verifier.');
  lines.push('');

  lines.push('## By submission type');
  lines.push('');
  lines.push('| Type | Rows | With URL | Link value weight |');
  lines.push('|---|---:|---:|---:|');
  for (const t of r.byType.sort((a, b) => b.weight - a.weight)) {
    lines.push(`| ${t.type} | ${t.rows} | ${t.withUrl} | ${t.weight.toFixed(2)} |`);
  }
  lines.push('');

  lines.push('## Findings by code');
  lines.push('');
  lines.push('| Code | Count |');
  lines.push('|---|---:|');
  for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${code} | ${n} |`);
  }
  lines.push('');

  for (const sev of ['high', 'medium', 'low'] as const) {
    const items = bySeverity(sev);
    if (!items.length) continue;
    lines.push(`## ${sev[0]!.toUpperCase()}${sev.slice(1)} severity (${items.length})`);
    lines.push('');
    for (const f of items) lines.push(`- \`${f.code}\` — ${f.message}`);
    lines.push('');
  }

  if (credFindings.length) {
    lines.push(`## Credential hygiene (${credFindings.length})`);
    lines.push('');
    lines.push('Passwords are never printed. These are verdicts only.');
    lines.push('');
    for (const f of credFindings) {
      const problems = f.detail ? (JSON.parse(f.detail).problems ?? []).join(', ') : '';
      lines.push(`- ${f.message}${problems ? ` — ${problems}` : ''}`);
    }
    lines.push('');
  }

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  log.info(`report → ${path}`);
  return path;
}

/** Console summary, for the CLI. */
export function printAudit(r: AuditResult) {
  log.heading('Audit summary');
  console.log(`  rows imported ............ ${r.total}`);
  console.log(`  with a backlink URL ...... ${r.withBacklink}`);
  console.log(`  nothing to verify ........ ${r.unverifiable}`);
  console.log(`  "Approved" with no URL ... ${r.claimedApprovedWithoutUrl}`);
  console.log(`  worth verifying .......... ${r.genuineCandidates}`);

  const counts = new Map<string, number>();
  for (const f of r.findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  console.log(
    `  findings ................. ${r.findings.length} ` +
      `(high ${counts.get('high') ?? 0}, medium ${counts.get('medium') ?? 0}, low ${counts.get('low') ?? 0})`,
  );
  console.log(`\n  full report: ${r.reportPath}\n`);
}
