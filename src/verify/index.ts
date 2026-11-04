/**
 * The verification pass: run checks, record them, move statuses.
 *
 * Status rules, and the reasoning behind the awkward one:
 *
 *   - link found                → `verified`
 *   - page gone (4xx)           → `lost`
 *   - page fine but no link, and the submission is recent → stays `submitted`,
 *     because bookmarking and directory sites moderate for days and calling it
 *     dead on day one would be wrong
 *   - page fine but no link after the grace period and repeated checks → `lost`
 *   - previously `verified`, now absent → `lost` immediately, since it was
 *     there once and something removed it
 *
 * Only this module may write `verified`. That rule is what makes the number
 * mean anything.
 */

import { all, get, run } from '../db/index.ts';
import type { ClientConfig } from '../config.ts';
import { mapLimit } from '../vetting/fetch.ts';
import { closeAllSessions } from '../submit/browser.ts';
import { log } from '../util/log.ts';
import { closeVerifyBrowser, verifyUrl, type VerifyOptions, type VerifyResult } from './check.ts';

/** How long a submission is given to clear moderation before it counts as lost. */
const GRACE_DAYS = 14;
const MIN_CHECKS_BEFORE_LOST = 3;

export interface VerifyRow {
  id: number;
  type: string;
  submitted_url: string;
  status: string;
  submitted_at: string | null;
  created_at: string;
  site_domain: string | null;
  checks: number;
  age_days: number;
}

export interface VerifyOutcome {
  submissionId: number;
  url: string;
  before: string;
  after: string;
  result: VerifyResult;
}

/**
 * What needs checking. Freshly submitted first, then whatever was checked
 * longest ago — so a daily run naturally re-sweeps the whole history.
 */
export function pendingVerification(
  clientId: string,
  opts: { limit?: number; resweep?: boolean } = {},
): VerifyRow[] {
  const statuses = opts.resweep
    ? "('submitted', 'verified', 'lost')"
    : "('submitted', 'verified')";

  return all<VerifyRow>(
    `SELECT s.id, s.type, s.submitted_url, s.status, s.submitted_at, s.created_at,
            si.domain AS site_domain,
            (SELECT COUNT(*) FROM verifications v WHERE v.submission_id = s.id) AS checks,
            CAST(julianday('now') - julianday(COALESCE(s.submitted_at, s.created_at)) AS INTEGER) AS age_days
       FROM submissions s
       LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ?
        AND s.submitted_url IS NOT NULL
        AND s.submitted_url != ''
        AND s.status IN ${statuses}
      ORDER BY (SELECT MAX(checked_at) FROM verifications v WHERE v.submission_id = s.id) ASC NULLS FIRST,
               s.id
      LIMIT ?`,
    clientId,
    opts.limit ?? 25,
  );
}

function decideStatus(row: VerifyRow, result: VerifyResult): string {
  if (result.linkPresent) return 'verified';

  // We could not see the page: unknown, never "gone". A platform that blocks
  // our fetcher tells us nothing about whether the link is still there, and
  // calling that a lost link would be the same error this project already made
  // once in vetting.
  if (result.inconclusive) return row.status;

  // The page itself is genuinely gone.
  if (result.httpStatus === 404 || result.httpStatus === 410) return 'lost';

  // It was verified before and the link has been removed since.
  if (row.status === 'verified') return 'lost';

  // Page loads, no link, and we have waited long enough and checked enough.
  if (row.age_days >= GRACE_DAYS && row.checks + 1 >= MIN_CHECKS_BEFORE_LOST) return 'lost';

  return 'submitted';
}

function record(submissionId: number, result: VerifyResult) {
  run(
    `INSERT INTO verifications
       (submission_id, http_status, link_present, rel, anchor_found, indexed, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    submissionId,
    result.httpStatus || null,
    result.linkPresent ? 1 : 0,
    result.follow,
    result.anchorFound,
    result.indexed === null ? null : result.indexed ? 1 : 0,
    `${result.method}: ${result.note}`.slice(0, 500),
  );
}

export async function verifyOne(
  cfg: ClientConfig,
  row: VerifyRow,
  opts: VerifyOptions & { useSession?: boolean } = {},
): Promise<VerifyOutcome> {
  const result = await verifyUrl(row.submitted_url, cfg.siteUrl, {
    ...opts,
    sessionDomain: opts.useSession ? (row.site_domain ?? undefined) : undefined,
  });
  record(row.id, result);

  const after = decideStatus(row, result);
  if (after !== row.status) {
    run(
      "UPDATE submissions SET status = ?, updated_at = datetime('now') WHERE id = ?",
      after,
      row.id,
    );
  }

  // A link that disappeared tells us something about the platform too.
  if (after === 'lost' && row.site_domain) {
    run(
      `UPDATE sites SET notes = COALESCE(notes || ' | ', '') || ?
         WHERE domain = ? AND (notes IS NULL OR notes NOT LIKE '%dropped a link%')`,
      `dropped a link (${new Date().toISOString().slice(0, 10)})`,
      row.site_domain,
    );
  }

  const mark = result.inconclusive
    ? '????'
    : after === 'verified'
      ? 'LIVE'
      : after === 'lost'
        ? 'LOST'
        : 'wait';
  log.info(
    `  ${mark}  ${(row.site_domain ?? '?').padEnd(26)} ${String(result.httpStatus).padEnd(4)} ` +
      `${(result.follow ?? '-').padEnd(10)} ${result.note.slice(0, 60)}`,
  );

  return { submissionId: row.id, url: row.submitted_url, before: row.status, after, result };
}

export interface VerifyStats {
  checked: number;
  verified: number;
  lost: number;
  waiting: number;
  mentionsOnly: number;
  nofollow: number;
  inconclusive: number;
}

export async function runVerification(
  cfg: ClientConfig,
  opts: VerifyOptions & {
    limit?: number;
    resweep?: boolean;
    concurrency?: number;
    useSession?: boolean;
  } = {},
): Promise<VerifyStats> {
  const rows = pendingVerification(cfg.id, { limit: opts.limit, resweep: opts.resweep });
  const stats: VerifyStats = {
    checked: 0,
    verified: 0,
    lost: 0,
    waiting: 0,
    mentionsOnly: 0,
    nofollow: 0,
    inconclusive: 0,
  };

  if (!rows.length) {
    log.info('nothing to verify — no submissions with a URL');
    return stats;
  }

  log.heading(`Verifying ${rows.length} URL${rows.length === 1 ? '' : 's'}`);
  console.log('  LIVE = the link is really there   LOST = gone   wait = page fine, no link yet\n');

  let outcomes;
  try {
    outcomes = await mapLimit(rows, opts.concurrency ?? 3, (row) => verifyOne(cfg, row, opts));
  } finally {
    // One shared browser for the run; close it however the run ends.
    await closeVerifyBrowser();
    if (opts.useSession) await closeAllSessions();
  }

  for (const o of outcomes) {
    stats.checked++;
    if (o.result.inconclusive) stats.inconclusive++;
    if (o.after === 'verified') stats.verified++;
    else if (o.after === 'lost') stats.lost++;
    else stats.waiting++;
    if (o.result.mentionOnly) stats.mentionsOnly++;
    if (o.result.follow && o.result.follow !== 'dofollow') stats.nofollow++;
  }

  return stats;
}

/** One submission by id, for checking a single thing by hand. */
export async function verifyById(
  cfg: ClientConfig,
  id: number,
  opts: VerifyOptions & { useSession?: boolean } = {},
) {
  const row = get<VerifyRow>(
    `SELECT s.id, s.type, s.submitted_url, s.status, s.submitted_at, s.created_at,
            si.domain AS site_domain,
            (SELECT COUNT(*) FROM verifications v WHERE v.submission_id = s.id) AS checks,
            CAST(julianday('now') - julianday(COALESCE(s.submitted_at, s.created_at)) AS INTEGER) AS age_days
       FROM submissions s LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.id = ?`,
    id,
  );
  if (!row) throw new Error(`No submission #${id}.`);
  if (!row.submitted_url) throw new Error(`Submission #${id} has no URL to check.`);
  return verifyOne(cfg, row, opts);
}
