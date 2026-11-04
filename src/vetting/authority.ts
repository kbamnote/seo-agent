/**
 * Authority signals, free ones only.
 *
 * This exists because of a real result from the first vetting run: a generic
 * bookmarking farm scored 90 while Substack scored 60. The submittability score
 * measures whether a machine can post there — nothing about whether a link from
 * there is worth having. Those are different questions and they need different
 * numbers.
 *
 * No paid API is used. What is available for nothing:
 *
 *   - **Domain age** via RDAP. A domain registered six months ago that already
 *     offers "submit your story" is a churn-and-burn farm. A twelve-year-old
 *     domain is at least real.
 *   - **Indexation**, via one `site:` search. A platform Google has dropped
 *     cannot pass anything, and this is the single strongest free signal — so
 *     it costs one search call and is opt-in.
 *   - **A sitemap** in robots.txt: weak, but free, and farms rarely bother.
 *
 * Deliberately absent: Domain Authority / Domain Rating. Both are vendor
 * metrics behind paid APIs. When a Moz or Ahrefs key exists later, it belongs
 * here as another contributor, not as a replacement.
 */

import { log } from '../util/log.ts';
import { getSearchProvider } from '../discovery/providers.ts';
import { getRobots } from './robots.ts';

export interface AuthorityInput {
  domain: string;
  https: boolean;
  checkIndex: boolean;
}

export interface AuthorityResult {
  score: number | null;
  ageYears: number | null;
  registered: string | null;
  indexed: boolean | null;
  hasSitemap: boolean;
  reasons: string[];
}

/** Registration date via RDAP. Returns null when the registry does not serve it. */
export async function domainRegistration(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json', 'user-agent': 'TapifySeoAgent/0.1' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
    const event = (data.events ?? []).find((e) => /registration/i.test(e.eventAction ?? ''));
    return event?.eventDate ?? null;
  } catch {
    // Plenty of ccTLDs (.in among them) serve no public RDAP. Not an error.
    return null;
  }
}

/** One `site:` search. null when no search provider is configured. */
export async function checkIndexed(domain: string): Promise<boolean | null> {
  try {
    const provider = getSearchProvider();
    if (provider.id === 'none') return null;
    const results = await provider.search(`site:${domain}`, 10);
    return results.length > 0;
  } catch (err) {
    log.debug(`index check failed for ${domain}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function assessAuthority(input: AuthorityInput): Promise<AuthorityResult> {
  const registered = await domainRegistration(input.domain);
  const ageYears = registered
    ? Number(((Date.now() - new Date(registered).getTime()) / 31_557_600_000).toFixed(1))
    : null;

  const indexed = input.checkIndex ? await checkIndexed(input.domain) : null;
  const robots = await getRobots(`https://${input.domain}/`);
  const hasSitemap = robots.sitemaps.length > 0;

  const reasons: string[] = [];
  let score = 50;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${n >= 0 ? '+' : ''}${n} ${why}`);
  };

  if (ageYears === null) {
    reasons.push('0 registration date unavailable (registry serves no RDAP)');
  } else if (ageYears >= 10) add(25, `domain is ${ageYears}y old`);
  else if (ageYears >= 5) add(15, `domain is ${ageYears}y old`);
  else if (ageYears >= 2) add(5, `domain is ${ageYears}y old`);
  else if (ageYears >= 1) add(-5, `domain is only ${ageYears}y old`);
  else add(-25, `domain is ${ageYears}y old — too new to trust`);

  if (indexed === false) add(-40, 'not in the search index — a link from here passes nothing');
  else if (indexed === true) add(10, 'indexed');

  if (hasSitemap) add(5, 'publishes a sitemap');
  if (input.https) add(5, 'https');
  else add(-5, 'no https');

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    ageYears,
    registered,
    indexed,
    hasSitemap,
    reasons,
  };
}

/**
 * What the agent sorts by when choosing where to submit next. Submittability
 * without authority builds link farms; authority without submittability builds
 * a wishlist. Both, times the category's own worth.
 */
export function pickScore(
  submittability: number | null,
  authority: number | null,
  typeWeight: number,
): number {
  const s = submittability ?? 0;
  const a = authority ?? 50; // unknown authority is treated as average, not bad
  return Math.round((0.45 * s + 0.55 * a) * typeWeight);
}
