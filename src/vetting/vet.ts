/**
 * Vetting orchestrator: fetch a candidate, read the page, score it, store the
 * verdict. One pass per site, re-runnable.
 */

import { all, get, run } from '../db/index.ts';
import type { SubmissionType } from '../config.ts';
import { log } from '../util/log.ts';
import { analysePage, mergeWorst, pickSamplePage } from './analyse.ts';
import { assessAuthority } from './authority.ts';
import { applyJudgement, judgeSite, type Judgement } from './judge.ts';
import { mapLimit, politeFetch } from './fetch.ts';
import { allowedToFetch, getRobots, isAllowed } from './robots.ts';
import { scoreBand, scoreSite } from './score.ts';

const SITE_FIELDS =
  'id, domain, name, home_url, categories, status, manual_only, adapter, discovered_via, blocklisted';

export interface SiteRow {
  id: number;
  domain: string;
  name: string | null;
  home_url: string | null;
  categories: string | null;
  status: string;
  manual_only: number;
  adapter: string | null;
  discovered_via: string | null;
  blocklisted: number;
}

export interface VetOutcome {
  siteId: number;
  domain: string;
  status: string;
  score: number;
  authority: number | null;
  band: string;
  rejectReason: string | null;
  captcha: string | null;
}

function firstCategory(categories: string | null): SubmissionType | null {
  try {
    const list = JSON.parse(categories || '[]') as SubmissionType[];
    return list[0] ?? null;
  } catch {
    return null;
  }
}

export async function vetSite(
  site: SiteRow,
  opts: { checkIndex?: boolean; judge?: boolean } = {},
): Promise<VetOutcome> {
  // A blocklisted domain is a decision, not a measurement. whois.com scores
  // perfectly well as a website; it is still not a place a backlink can exist.
  // Vetting must never be able to talk us back into one.
  if (site.blocklisted) {
    log.info(`${site.domain.padEnd(30)} blocklisted — skipped`);
    return {
      siteId: site.id,
      domain: site.domain,
      status: 'rejected',
      score: 0,
      authority: null,
      band: 'blocklisted',
      rejectReason: 'blocklisted',
      captcha: null,
    };
  }

  const url = site.home_url || `https://${site.domain}/`;
  const type = firstCategory(site.categories);

  const robots = await getRobots(url);
  let robotsAllowed = true;
  try {
    const u = new URL(url);
    robotsAllowed = isAllowed(robots, u.pathname + u.search);
  } catch {
    robotsAllowed = false;
  }

  const res = robotsAllowed
    ? await politeFetch(url)
    : { ok: false, status: 0, finalUrl: url, contentType: '', html: '', elapsedMs: 0, truncated: false };

  const homeSignals =
    res.html && /html|xml/i.test(res.contentType) ? analysePage(res.html, res.finalUrl) : null;

  // Sample one inner content page. This is where link farms give themselves
  // away — the homepage never does.
  let signals = homeSignals;
  let sampleUrl: string | null = null;
  if (homeSignals && !homeSignals.parked) {
    sampleUrl = pickSamplePage(res.html, res.finalUrl);
    if (sampleUrl && (await allowedToFetch(sampleUrl))) {
      const innerRes = await politeFetch(sampleUrl);
      if (innerRes.html && /html|xml/i.test(innerRes.contentType)) {
        signals = mergeWorst(homeSignals, analysePage(innerRes.html, innerRes.finalUrl));
      }
    }
  }

  const verdict = scoreSite({ fetch: res, signals, robotsAllowed, type });

  /**
   * A site we already have a working adapter for, or that a human curated into
   * the seed catalog, has evidence behind it that a homepage crawl does not
   * see. `marginal` must not demote those — the first run marked justpaste.it
   * unusable, a platform the team has published on successfully.
   */
  const trusted = Boolean(site.adapter) || site.discovered_via === 'seed-catalog';
  const judgement: Judgement | null =
    opts.judge && signals && verdict.verdict !== 'reject' ? await judgeSite(site.domain, signals) : null;

  const status =
    verdict.verdict === 'reject'
      ? 'rejected'
      : verdict.verdict === 'blocked'
        ? 'blocked'
        : verdict.verdict === 'marginal'
          ? trusted
            ? 'vetted'
            : 'marginal'
          : 'vetted';

  const reason =
    verdict.verdict === 'marginal' && trusted
      ? `${verdict.reason} — kept: ${site.adapter ? 'has an adapter' : 'curated seed site'}`
      : verdict.reason;

  // Authority is only worth the calls for a site still in play.
  const rawAuthority =
    status === 'rejected'
      ? null
      : await assessAuthority({
          domain: site.domain,
          https: res.finalUrl.startsWith('https://'),
          checkIndex: Boolean(opts.checkIndex),
        });

  const applied = applyJudgement(judgement, rawAuthority?.score ?? null);
  const finalStatus = applied.reject ? 'rejected' : status;
  const finalReason = applied.reject ? 'link_farm_editorial' : reason;

  run(
    `UPDATE sites SET
       status = ?, score = ?, authority = ?, reject_reason = ?, vetted_at = datetime('now'),
       http_status = ?, final_url = ?, robots_allowed = ?, signals_json = ?,
       nofollow_ratio = ?, external_links = ?, captcha_vendor = ?, language = ?,
       requires_captcha = ?, dofollow = ?, submit_url = COALESCE(submit_url, ?),
       name = COALESCE(name, ?)
     WHERE id = ?`,
    finalStatus,
    verdict.score,
    applied.authority,
    finalReason,
    res.status || null,
    res.finalUrl || null,
    robotsAllowed ? 1 : 0,
    JSON.stringify({
      signals,
      reasons: verdict.reasons,
      authority: rawAuthority ?? undefined,
      judgement: judgement ?? undefined,
      judgementNote: applied.note ?? undefined,
      sampleUrl,
      fetchMs: res.elapsedMs,
    }),
    signals?.nofollowRatio ?? null,
    signals?.externalLinks ?? null,
    signals?.captchaVendor ?? null,
    signals?.language ?? null,
    signals ? (signals.captchaVendor ? 1 : 0) : null,
    signals && signals.nofollowRatio !== null ? (signals.nofollowRatio <= 0.5 ? 1 : 0) : null,
    signals?.submitCandidates[0] ?? null,
    signals?.title?.slice(0, 120) ?? null,
    site.id,
  );

  const outcome: VetOutcome = {
    siteId: site.id,
    domain: site.domain,
    status: finalStatus,
    score: verdict.score,
    authority: applied.authority,
    band: scoreBand(verdict.score),
    rejectReason: finalReason,
    captcha: signals?.captchaVendor ?? null,
  };

  log.info(
    `${site.domain.padEnd(30)} sub ${String(verdict.score).padStart(3)}  ` +
      `auth ${String(applied.authority ?? '-').padStart(3)}  ${finalStatus.padEnd(9)}` +
      (judgement ? ` ${judgement.verdict.padEnd(9)}` : '') +
      (finalReason ? ` ${finalReason}` : '') +
      (signals?.captchaVendor ? `  [${signals.captchaVendor}]` : ''),
  );
  return outcome;
}

export interface VetOptions {
  type?: SubmissionType;
  limit?: number;
  concurrency?: number;
  /** Re-vet sites already vetted (default: only unvetted candidates). */
  revet?: boolean;
  /** Include rejected sites when re-vetting. */
  includeRejected?: boolean;
  /** Spend one search call per site to check it is still indexed. */
  checkIndex?: boolean;
  /** Spend one LLM call per site to judge editorial control. */
  judge?: boolean;
}

export function pendingSites(opts: VetOptions = {}): SiteRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (!opts.revet) clauses.push('vetted_at IS NULL');
  // A rejection is permanent by design; 'blocked' and 'marginal' are not, so
  // they stay eligible for another pass.
  if (!opts.includeRejected) clauses.push("status != 'rejected'");
  clauses.push('blocklisted = 0');
  if (opts.type) {
    // categories is a JSON array; a LIKE on the quoted value is exact enough
    // for a fixed vocabulary of nine type names.
    clauses.push('categories LIKE ?');
    params.push(`%"${opts.type}"%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  return all<SiteRow>(
    `SELECT ${SITE_FIELDS}
       FROM sites ${where}
      ORDER BY (score IS NULL) DESC, discovered_at ASC
      LIMIT ?`,
    ...params,
    limit,
  );
}

export async function vetPending(opts: VetOptions = {}): Promise<VetOutcome[]> {
  const sites = pendingSites(opts);
  if (!sites.length) {
    log.info('nothing to vet');
    return [];
  }

  log.heading(`Vetting ${sites.length} site${sites.length === 1 ? '' : 's'}`);
  console.log('  sub = submittability (can a machine post here), auth = authority (is a link worth having)\n');
  // Concurrency is across hosts; fetch.ts serialises per host regardless.
  return mapLimit(sites, opts.concurrency ?? 4, (site) =>
    vetSite(site, { checkIndex: opts.checkIndex, judge: opts.judge }),
  );
}

export function vetOne(
  domain: string,
  opts: { checkIndex?: boolean; judge?: boolean } = {},
): Promise<VetOutcome> {
  const site = get<SiteRow>(
    `SELECT ${SITE_FIELDS} FROM sites WHERE domain = ?`,
    domain.toLowerCase().replace(/^www\./, ''),
  );
  if (!site) throw new Error(`${domain} is not in the catalog. Add it with \`discover add\`.`);
  return vetSite(site, opts);
}
