/**
 * IndexNow — and a correction to this project's earlier plan.
 *
 * The plan said "Ping submission" would be replaced by "IndexNow + sitemap ping
 * for every new backlink URL". That is not possible, and saying so earlier was
 * wrong on two counts:
 *
 *   1. **IndexNow only accepts URLs on a host whose key file you publish.** The
 *      key has to live at `https://<host>/<key>.txt`, and every URL in a
 *      submission must belong to that host. We do not control telegra.ph or
 *      padlet.com, so their URLs can never be submitted by us. IndexNow is
 *      useful here for exactly one domain: the client's own.
 *   2. **Sitemap ping is gone.** Google retired its `/ping?sitemap=` endpoint in
 *      2023 and Bing deprecated theirs. There is nothing left to call.
 *
 * So what can actually be done about a backlink page that is not getting
 * crawled? Nothing you can submit. You can check whether it is indexed — which
 * the verifier does, and an unindexed backlink passes nothing — and you can
 * stop spending effort on platforms whose pages never get indexed. That check
 * and that report are the honest replacement for "ping submission".
 *
 * What this module does, therefore: submits the **client's own** URLs to
 * IndexNow, which is genuinely worth doing whenever their site gains or changes
 * a page.
 */

import { all, run } from '../db/index.ts';
import type { ClientConfig } from '../config.ts';
import { log } from '../util/log.ts';

/** IndexNow is a shared protocol; one call reaches the participating engines. */
const ENDPOINT = 'https://api.indexnow.org/indexnow';

export interface IndexNowResult {
  ok: boolean;
  status: number;
  submitted: number;
  message: string;
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * Submits URLs belonging to the client's own site.
 *
 * Requires INDEXNOW_KEY in .env and that same key published as a text file at
 * the site root. Without the file, the API answers 403 — it is how the engines
 * confirm you control the host.
 */
export async function submitToIndexNow(
  cfg: ClientConfig,
  urls: string[],
): Promise<IndexNowResult> {
  const key = process.env.INDEXNOW_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      status: 0,
      submitted: 0,
      message:
        'INDEXNOW_KEY is not set. Generate any 8-128 character hex string, put it in .env, ' +
        `and publish it at ${cfg.siteUrl.replace(/\/$/, '')}/<key>.txt containing just the key.`,
    };
  }

  const clientHost = hostOf(cfg.siteUrl);
  const own = urls.filter((u) => {
    try {
      return hostOf(u) === clientHost;
    } catch {
      return false;
    }
  });
  const foreign = urls.length - own.length;

  if (foreign > 0) {
    log.warn(
      `${foreign} URL(s) are not on ${clientHost} and were dropped. IndexNow only accepts ` +
        'URLs for the host that publishes the key file — third-party backlink pages cannot ' +
        'be submitted by us at all.',
    );
  }
  if (!own.length) {
    return { ok: false, status: 0, submitted: 0, message: 'no URLs on the client\'s own host' };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: clientHost,
        key,
        keyLocation: `${cfg.siteUrl.replace(/\/$/, '')}/${key}.txt`,
        urlList: own.slice(0, 10_000),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const message =
      res.status === 200
        ? 'accepted'
        : res.status === 202
          ? 'accepted, key validation pending'
          : res.status === 403
            ? `rejected: the key file is not readable at ${cfg.siteUrl}/${key}.txt`
            : res.status === 422
              ? 'rejected: URLs do not belong to the host, or the key does not match'
              : res.status === 429
                ? 'rate limited — try fewer, less often'
                : `unexpected status ${res.status}`;

    return { ok: res.status === 200 || res.status === 202, status: res.status, submitted: own.length, message };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      submitted: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The actionable part of "ping": which backlink pages are not indexed.
 *
 * A backlink on a page Google has never indexed passes nothing. This does not
 * fix those pages — nothing we can call will — but it says which platforms are
 * wasting the client's time, which is the decision that actually matters.
 */
export interface IndexationReport {
  checked: number;
  indexed: number;
  notIndexed: Array<{ submissionId: number; url: string; domain: string | null; days: number }>;
  unknown: number;
}

export function indexationReport(clientId: string): IndexationReport {
  const rows = all<{
    submission_id: number;
    url: string;
    domain: string | null;
    indexed: number | null;
    days: number;
  }>(
    `SELECT s.id AS submission_id, s.submitted_url AS url, si.domain,
            v.indexed,
            CAST(julianday('now') - julianday(COALESCE(s.submitted_at, s.created_at)) AS INTEGER) AS days
       FROM submissions s
       LEFT JOIN sites si ON si.id = s.site_id
       LEFT JOIN verifications v ON v.id = (
            SELECT id FROM verifications w WHERE w.submission_id = s.id
             ORDER BY checked_at DESC, id DESC LIMIT 1)
      WHERE s.client_id = ? AND s.status = 'verified'`,
    clientId,
  );

  const report: IndexationReport = { checked: 0, indexed: 0, notIndexed: [], unknown: 0 };
  for (const r of rows) {
    report.checked++;
    if (r.indexed === 1) report.indexed++;
    else if (r.indexed === 0)
      report.notIndexed.push({
        submissionId: r.submission_id,
        url: r.url,
        domain: r.domain,
        days: r.days,
      });
    else report.unknown++;
  }
  return report;
}

/** Records an IndexNow call in the run log, so quota use is visible. */
export function logIndexNow(clientId: string, result: IndexNowResult): void {
  run(
    `INSERT INTO runs (kind, client_id, finished_at, status, stats_json)
     VALUES ('indexnow', ?, datetime('now'), ?, ?)`,
    clientId,
    result.ok ? 'ok' : 'error',
    JSON.stringify(result),
  );
}
