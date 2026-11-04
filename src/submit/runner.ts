/**
 * The submission runner: what to send, where, how often, and what to record.
 *
 * Pacing is not politeness here, it is survival. Forty links in an afternoon
 * from one IP, all pointing at one domain, is the footprint that gets a link
 * profile discounted and the accounts banned. The quotas in the client config
 * are low on purpose, and `minMinutesBetweenSubmissions` is enforced between
 * every single send.
 *
 * Nothing in here decides whether a link is good. It decides whether the agent
 * is allowed to try, does the trying, and records exactly what happened —
 * including "nothing happened, a human is needed".
 */

import { all, get, run } from '../db/index.ts';
import type { ClientConfig, SubmissionType } from '../config.ts';
import { log } from '../util/log.ts';
import { isSendable } from '../content/approval.ts';
import { ensureAccount, reveal } from './accounts.ts';
import { adapterFor } from './adapters/index.ts';
import type { SubmitOutcome } from './adapters/types.ts';
import { closeAllSessions, openSession } from './browser.ts';

export interface WorkItem {
  contentId: number;
  type: SubmissionType;
  title: string;
  body: string;
  anchorText: string;
  targetUrl: string;
  assetPath: string | null;
  keywordId: number | null;
  keywordText: string | null;
  siteId: number;
  siteDomain: string;
  submitUrl: string | null;
  siteAdapter: string | null;
  manualOnly: number;
  requiresAccount: number;
  firstUse: boolean;
}

export interface Quotas {
  perDayTotal: number;
  perDayPerType: Record<string, number>;
  perSitePerWeek: number;
  minMinutesBetweenSubmissions: number;
}

function quotasOf(cfg: ClientConfig): Quotas {
  const q = (cfg.quotas ?? {}) as Partial<Quotas>;
  return {
    perDayTotal: Number(q.perDayTotal ?? 8),
    perDayPerType: (q.perDayPerType ?? {}) as Record<string, number>,
    perSitePerWeek: Number(q.perSitePerWeek ?? 1),
    minMinutesBetweenSubmissions: Number(q.minMinutesBetweenSubmissions ?? 12),
  };
}

/**
 * What the agent itself has sent today.
 *
 * `manual_queue` is excluded deliberately. A brief handed to a person is not
 * something the agent published — the human posts it whenever they get to it,
 * so it adds nothing to the automated footprint the quota exists to limit.
 * Counting it cost a real run: exporting one dev.to brief consumed the whole
 * daily blog allowance of 1, and the WordPress submission was skipped.
 *
 * `failed` is excluded for the same reason. The quota limits what reaches the
 * public web; an attempt that published nothing should not spend the day's
 * allowance. Runaway retries are stopped by `consecutive_failures`, which is
 * the right tool for that job.
 */
function sentToday(clientId: string, type?: SubmissionType): number {
  const row = type
    ? get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM submissions
          WHERE client_id = ? AND type = ? AND source = 'agent'
            AND status NOT IN ('manual_queue', 'failed')
            AND date(created_at) = date('now')`,
        clientId,
        type,
      )
    : get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM submissions
          WHERE client_id = ? AND source = 'agent'
            AND status NOT IN ('manual_queue', 'failed')
            AND date(created_at) = date('now')`,
        clientId,
      );
  return row?.n ?? 0;
}

export interface QuotaReport {
  totalUsed: number;
  totalLeft: number;
  byType: Array<{ type: string; used: number; limit: number; left: number }>;
  minutesBetween: number;
}

export function quotaReport(cfg: ClientConfig): QuotaReport {
  const q = quotasOf(cfg);
  const totalUsed = sentToday(cfg.id);
  return {
    totalUsed,
    totalLeft: Math.max(0, q.perDayTotal - totalUsed),
    byType: Object.entries(q.perDayPerType).map(([type, limit]) => {
      const used = sentToday(cfg.id, type as SubmissionType);
      return { type, used, limit: Number(limit), left: Math.max(0, Number(limit) - used) };
    }),
    minutesBetween: q.minMinutesBetweenSubmissions,
  };
}

/**
 * Content that is ready to go out, paired with a site.
 *
 * A content item carries its own `site_id` from generation — the asset was
 * written *for* that platform, so sending it elsewhere would waste the
 * tailoring. Items generated untargeted are skipped rather than guessed at.
 */
export function pickWork(cfg: ClientConfig, opts: { type?: SubmissionType; limit?: number } = {}): WorkItem[] {
  const q = quotasOf(cfg);
  const rows = all<WorkItem & { approval: string; generator: string | null }>(
    `SELECT c.id AS contentId, c.type, c.title, c.body, c.anchor_text AS anchorText,
            c.target_url AS targetUrl, c.asset_path AS assetPath, c.keyword_id AS keywordId,
            k.keyword AS keywordText, c.approval, c.generator,
            s.id AS siteId, s.domain AS siteDomain, s.submit_url AS submitUrl,
            s.adapter AS siteAdapter, s.manual_only AS manualOnly, s.status AS status,
            s.requires_account AS requiresAccount,
            (SELECT COUNT(*) FROM submissions ss WHERE ss.site_id = s.id AND ss.client_id = c.client_id) AS priorUses,
            (SELECT COUNT(*) FROM submissions sf WHERE sf.content_id = c.id AND sf.status = 'failed') AS failedAttempts
       FROM content_items c
       JOIN sites s ON s.id = c.site_id
       LEFT JOIN keywords k ON k.id = c.keyword_id
      WHERE c.client_id = ?
        AND c.site_id IS NOT NULL
        AND s.blocklisted = 0
        -- manual_only means the platform's terms forbid automated posting. Those
        -- items belong to the manual queue and must never reach the runner.
        AND s.manual_only = 0
        -- 'blocked' is included deliberately: it means our *crawler* was turned
        -- away during vetting, which is irrelevant to an API adapter. The JS
        -- filter below drops blocked sites for browser adapters.
        AND s.status IN ('vetted', 'active', 'blocked')
        -- A failed attempt must not retire the asset. Excluding every submission
        -- row stranded article #19 permanently the moment one platform rejected
        -- it; only a real outcome should consume the content.
        AND NOT EXISTS (
          SELECT 1 FROM submissions sub
           WHERE sub.content_id = c.id AND sub.status != 'failed')
        -- And stop walking into a platform that keeps failing.
        AND s.consecutive_failures < 3
        ${opts.type ? 'AND c.type = ?' : ''}
      -- Content that has already failed goes to the BACK of the queue. Ordering
      -- by id alone meant one failing platform was retried ahead of every newer
      -- asset, so a single bad target could starve the whole run.
      ORDER BY failedAttempts ASC, c.id ASC`,
    ...(opts.type ? [cfg.id, opts.type] : [cfg.id]),
  );

  const picked: WorkItem[] = [];
  const perTypeUsed = new Map<string, number>();
  let totalUsed = sentToday(cfg.id);

  for (const row of rows) {
    if (picked.length >= (opts.limit ?? 5)) break;
    if (totalUsed >= q.perDayTotal) {
      log.info(`daily total quota reached (${q.perDayTotal})`);
      break;
    }

    const sendable = isSendable(row.contentId);
    if (!sendable.ok) {
      log.info(`#${row.contentId} held back: ${sendable.why}`);
      continue;
    }

    // A browser adapter cannot work on a site that refused our crawler; an API
    // adapter never opens a browser, so it is unaffected.
    const adapter = adapterFor(row.siteDomain, row.siteAdapter);
    if ((row as unknown as { status?: string }).status === 'blocked' && !adapter.apiOnly) {
      log.debug(`#${row.contentId} skipped: ${row.siteDomain} is blocked and ${adapter.id} needs a browser`);
      continue;
    }

    const typeLimit = Number(q.perDayPerType[row.type] ?? q.perDayTotal);
    const typeUsed = perTypeUsed.get(row.type) ?? sentToday(cfg.id, row.type);
    if (typeUsed >= typeLimit) {
      log.info(`#${row.contentId} held back: today's ${row.type} quota is used (${typeLimit}/day)`);
      continue;
    }

    /**
     * Per-site pacing, measured by when a link was really submitted.
     *
     * This read `created_at` — the row's creation date — which for an imported
     * row is the day the tracker was imported, not the day the link was built.
     * Every platform the team had ever used therefore looked "used this week",
     * permanently and invisibly, locking the agent out of all of them. The real
     * date lives in `submitted_at`.
     *
     * Failed attempts are excluded: nothing was published, so nothing was paced.
     */
    const recentOnSite = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE site_id = ? AND client_id = ?
          AND status != 'failed'
          AND COALESCE(submitted_at, created_at) > datetime('now', '-7 days')`,
      row.siteId,
      cfg.id,
    );
    if ((recentOnSite?.n ?? 0) >= q.perSitePerWeek) {
      log.info(`#${row.contentId} held back: ${row.siteDomain} already used this week`);
      continue;
    }

    picked.push({ ...row, firstUse: (row as unknown as { priorUses: number }).priorUses === 0 });
    perTypeUsed.set(row.type, typeUsed + 1);
    totalUsed++;
  }

  return picked;
}

/** Items whose platform forbids automation — a human posts these. */
export function pickManual(cfg: ClientConfig, limit = 20): WorkItem[] {
  return all<WorkItem>(
    `SELECT c.id AS contentId, c.type, c.title, c.body, c.anchor_text AS anchorText,
            c.target_url AS targetUrl, c.asset_path AS assetPath, c.keyword_id AS keywordId,
            k.keyword AS keywordText, s.id AS siteId, s.domain AS siteDomain,
            s.submit_url AS submitUrl, s.adapter AS siteAdapter, s.manual_only AS manualOnly,
            s.requires_account AS requiresAccount, 0 AS firstUse
       FROM content_items c
       JOIN sites s ON s.id = c.site_id
       LEFT JOIN keywords k ON k.id = c.keyword_id
      WHERE c.client_id = ? AND s.manual_only = 1 AND s.blocklisted = 0
        -- Outstanding work, not just new work. The export rewrites the file, so
        -- excluding already-queued items silently dropped a brief that nobody
        -- had posted yet. An item leaves this list when a human records its URL.
        AND NOT EXISTS (
          SELECT 1 FROM submissions sub
           WHERE sub.content_id = c.id
             AND sub.status != 'failed'
             AND NOT (sub.status = 'manual_queue'
                      AND (sub.submitted_url IS NULL OR sub.submitted_url = '')))
      ORDER BY c.id LIMIT ?`,
    cfg.id,
    limit,
  );
}

function recordSubmission(cfg: ClientConfig, work: WorkItem, status: string): number {
  const res = run(
    `INSERT INTO submissions
       (client_id, site_id, keyword_id, content_id, type, platform_url, keyword_text,
        status, operator, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seo-agent', 'agent')`,
    cfg.id,
    work.siteId,
    work.keywordId,
    work.contentId,
    work.type,
    `https://${work.siteDomain}/`,
    work.keywordText,
    status,
  );
  return Number(res.lastInsertRowid);
}

function finishSubmission(id: number, outcome: SubmitOutcome, attempts: number) {
  const status =
    outcome.status === 'submitted'
      ? 'submitted'
      : outcome.status === 'needs_assist'
        ? 'needs_assist'
        : 'failed';

  run(
    `UPDATE submissions SET
       status = ?, submitted_url = ?, last_error = ?, attempts = ?,
       submitted_at = CASE WHEN ? = 'submitted' THEN datetime('now') ELSE submitted_at END,
       updated_at = datetime('now')
     WHERE id = ?`,
    status,
    outcome.liveUrl ?? null,
    outcome.note ?? null,
    attempts,
    status,
    id,
  );
}

export async function submitOne(cfg: ClientConfig, work: WorkItem): Promise<SubmitOutcome> {
  const adapter = adapterFor(work.siteDomain, work.siteAdapter);
  const submissionId = recordSubmission(cfg, work, 'submitting');

  log.info(
    `→ ${work.siteDomain} (${adapter.id}${adapter.confidence === 'untested' ? ', untested' : ''}) ` +
      `${work.type} #${work.contentId}`,
  );

  let account: { username: string; email: string | null; password: string } | null = null;
  if (adapter.requiresAccount && work.requiresAccount) {
    try {
      const ensured = ensureAccount(cfg, work.siteId, work.siteDomain);
      account = {
        username: ensured.account.username ?? '',
        email: ensured.account.email,
        password: ensured.password ?? reveal(ensured.account),
      };
    } catch (err) {
      const outcome: SubmitOutcome = {
        status: 'failed',
        note: `account unavailable: ${err instanceof Error ? err.message : err}`,
      };
      finishSubmission(submissionId, outcome, 1);
      return outcome;
    }
  }

  const payload = {
    title: work.title,
    body: work.body,
    url: work.targetUrl,
    anchorText: work.anchorText,
    tags: work.keywordText ? [work.keywordText] : undefined,
    name: cfg.name,
    email: cfg.contact?.email,
    username: account?.username,
    password: account?.password,
    phone: cfg.contact?.phone,
    city: cfg.city,
    assetPath: work.assetPath ?? undefined,
  };

  let outcome: SubmitOutcome;
  try {
    if (adapter.apiOnly) {
      // No browser at all — nothing to open, nothing to leave behind.
      outcome = await adapter.submit({
        page: undefined as never,
        payload,
        cfg,
        siteDomain: work.siteDomain,
        submitUrl: work.submitUrl,
        account,
        firstUse: work.firstUse,
      });
    } else {
      const session = await openSession(work.siteDomain);
      outcome = await adapter.submit({
        page: session.page,
        payload,
        cfg,
        siteDomain: work.siteDomain,
        submitUrl: work.submitUrl,
        account,
        firstUse: work.firstUse,
      });
    }
  } catch (err) {
    outcome = { status: 'failed', note: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }

  finishSubmission(submissionId, outcome, 1);

  if (outcome.status === 'submitted') {
    run('UPDATE content_items SET used_count = used_count + 1 WHERE id = ?', work.contentId);
    run(
      "UPDATE sites SET last_success_at = datetime('now'), consecutive_failures = 0, status = 'active' WHERE id = ?",
      work.siteId,
    );
    log.info(`  submitted → ${outcome.liveUrl}`);
  } else {
    run(
      `UPDATE sites SET last_failure_at = datetime('now'),
         consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
      work.siteId,
    );
    log.warn(`  ${outcome.status}: ${outcome.note ?? 'no detail'}`);
  }

  return outcome;
}

export interface RunStats {
  attempted: number;
  submitted: number;
  needsAssist: number;
  failed: number;
}

export async function runBatch(
  cfg: ClientConfig,
  opts: { type?: SubmissionType; limit?: number; dryRun?: boolean; ignorePacing?: boolean } = {},
): Promise<RunStats> {
  const q = quotasOf(cfg);
  const work = pickWork(cfg, { type: opts.type, limit: opts.limit });
  const stats: RunStats = { attempted: 0, submitted: 0, needsAssist: 0, failed: 0 };

  if (!work.length) {
    log.info('nothing ready to submit');
    console.log(
      '\n  Ready work needs: approved content (not template), generated for a vetted\n' +
        '  platform, within quota, and not already submitted.\n' +
        '  Check:  npm run content -- pending     npm run submit -- plan\n',
    );
    return stats;
  }

  if (opts.dryRun) {
    log.heading(`Would submit ${work.length}`);
    for (const w of work) {
      const adapter = adapterFor(w.siteDomain, w.siteAdapter);
      console.log(
        `  ${w.siteDomain.padEnd(26)} ${w.type.padEnd(12)} #${String(w.contentId).padEnd(4)} ` +
          `${adapter.id}${adapter.confidence === 'untested' ? ' (untested)' : ''}  "${w.anchorText}"`,
      );
    }
    console.log('');
    return stats;
  }

  try {
    for (const [i, item] of work.entries()) {
      if (i > 0 && !opts.ignorePacing) {
        const waitMs = q.minMinutesBetweenSubmissions * 60_000;
        log.info(`pacing: waiting ${q.minMinutesBetweenSubmissions} min before the next submission`);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      stats.attempted++;
      const outcome = await submitOne(cfg, item);
      if (outcome.status === 'submitted') stats.submitted++;
      else if (outcome.status === 'needs_assist') stats.needsAssist++;
      else stats.failed++;
    }
  } finally {
    await closeAllSessions();
  }

  return stats;
}
