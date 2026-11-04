/**
 * Candidate harvesting.
 *
 * Two sources, both cheap:
 *
 *   1. The footprint queries themselves — a result is a candidate platform.
 *   2. The listicles those queries inevitably return ("Top 100 bookmarking
 *      sites 2026"). Those pages are worthless as links and excellent as
 *      *source material*: one fetch yields fifty candidate domains for one
 *      search call. `--expand-lists` turns this on.
 *
 * Nothing here judges a site. Everything lands as `candidate` and waits for
 * the vetter.
 */

import { all, get, run } from '../db/index.ts';
import type { ClientConfig, SubmissionType } from '../config.ts';
import { domainOf } from '../sheets/schema.ts';
import { log } from '../util/log.ts';
import { extractCandidateDomains } from '../vetting/analyse.ts';
import { politeFetch } from '../vetting/fetch.ts';
import { allowedToFetch } from '../vetting/robots.ts';
import { plannedQueries } from './footprints.ts';
import { getSearchProvider, type SearchResult } from './providers.ts';

/**
 * Domains that turn up constantly in these searches and are never a submission
 * target: search engines, the giants, reference sites, and the SEO blogs whose
 * listicles we mine for candidates but would never submit to.
 */
const NEVER_A_CANDIDATE = new Set([
  'google.com',
  'google.co.in',
  'bing.com',
  'duckduckgo.com',
  'yahoo.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'whatsapp.com',
  'wikipedia.org',
  'wikimedia.org',
  'amazon.com',
  'amazon.in',
  'flipkart.com',
  'apple.com',
  'microsoft.com',
  'play.google.com',
  'translate.google.com',
  'moz.com',
  'ahrefs.com',
  'semrush.com',
  'similarweb.com',
  'searchenginejournal.com',
  'searchengineland.com',
  'backlinko.com',
  'neilpatel.com',
  'hubspot.com',
  'wordstream.com',
  'bloggerspassion.com',
  'shoutmeloud.com',
  'whois.com',
  'who.is',
  'godaddy.com',
  'namecheap.com',
  'hostinger.com',
  'cloudflare.com',
  'w3schools.com',
  'stackoverflow.com',
  'quoracdn.net',
  'gstatic.com',
  'googleusercontent.com',
  'blogspot.com',
  'archive.org',
  'bit.ly',
  'tinyurl.com',
]);

const LISTICLE_TITLE = /\b(top|best|list of|free)\b.*\b(\d{2,}|sites?|list|websites?)\b/i;
const LISTICLE_URL = /\b(top|best|list|sites)\b/i;

export interface HarvestOptions {
  type: SubmissionType;
  maxQueries?: number;
  perQuery?: number;
  expandLists?: boolean;
  provider?: string;
  dryRun?: boolean;
  /** Skip a query that was already run this many days ago. */
  freshDays?: number;
}

export interface HarvestStats {
  type: SubmissionType;
  provider: string;
  queriesPlanned: number;
  queriesRun: number;
  queriesSkipped: number;
  results: number;
  listiclesExpanded: number;
  candidatesNew: number;
  candidatesKnown: number;
  errors: number;
}

function isJunk(domain: string, clientDomain: string | null): boolean {
  if (!domain) return true;
  if (clientDomain && domain === clientDomain) return true;
  if (NEVER_A_CANDIDATE.has(domain)) return true;
  // Country variants of the giants (google.co.uk, amazon.de ...).
  if (/^(google|bing|yahoo|amazon|facebook)\./.test(domain)) return true;
  // Obvious non-platforms.
  if (/\.(gov|gov\.in|mil|edu)$/.test(domain)) return true;
  return false;
}

function looksLikeListicle(r: SearchResult): boolean {
  return LISTICLE_TITLE.test(r.title) || (LISTICLE_URL.test(r.url) && /\b\d{2,}\b/.test(r.title));
}

function recentlyRun(query: string, freshDays: number): boolean {
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM discovery_queries
      WHERE query = ? AND error IS NULL AND ran_at > datetime('now', ?)`,
    query,
    `-${freshDays} days`,
  );
  return (row?.n ?? 0) > 0;
}

function addCandidate(
  domain: string,
  type: SubmissionType,
  via: string,
  homeUrl?: string,
): 'new' | 'known' {
  const existing = get<{ id: number; categories: string | null; status: string; blocklisted: number }>(
    'SELECT id, categories, status, blocklisted FROM sites WHERE domain = ?',
    domain,
  );

  if (existing) {
    // A rejected or blocklisted site stays that way — remembering is the point.
    if (existing.status !== 'rejected' && !existing.blocklisted) {
      const cats = new Set<string>(JSON.parse(existing.categories || '[]'));
      if (!cats.has(type)) {
        cats.add(type);
        run('UPDATE sites SET categories = ? WHERE id = ?', JSON.stringify([...cats]), existing.id);
      }
    }
    return 'known';
  }

  run(
    `INSERT INTO sites (domain, name, home_url, categories, status, discovered_via)
     VALUES (?, ?, ?, ?, 'candidate', ?)`,
    domain,
    domain,
    homeUrl ?? `https://${domain}/`,
    JSON.stringify([type]),
    via.slice(0, 300),
  );
  return 'new';
}

export async function harvest(cfg: ClientConfig, opts: HarvestOptions): Promise<HarvestStats> {
  const provider = getSearchProvider(opts.provider);
  const maxQueries = opts.maxQueries ?? 4;
  const perQuery = opts.perQuery ?? 20;
  const freshDays = opts.freshDays ?? 7;
  const clientDomain = domainOf(cfg.siteUrl);

  const queries = plannedQueries(opts.type, cfg, maxQueries);
  const stats: HarvestStats = {
    type: opts.type,
    provider: provider.id,
    queriesPlanned: queries.length,
    queriesRun: 0,
    queriesSkipped: 0,
    results: 0,
    listiclesExpanded: 0,
    candidatesNew: 0,
    candidatesKnown: 0,
    errors: 0,
  };

  if (!queries.length) {
    log.warn(`no footprints defined for type "${opts.type}" — add some to config/footprints.json`);
    return stats;
  }

  if (opts.dryRun) {
    log.heading(`Planned queries (${provider.id}, dry run)`);
    for (const q of queries) console.log(`  [${q.id}] ${q.query}`);
    return stats;
  }

  for (const q of queries) {
    if (recentlyRun(q.query, freshDays)) {
      log.info(`skip (run in the last ${freshDays}d): ${q.query}`);
      stats.queriesSkipped++;
      continue;
    }

    let results: SearchResult[] = [];
    try {
      results = await provider.search(q.query, perQuery);
      stats.queriesRun++;
    } catch (err) {
      stats.errors++;
      const message = err instanceof Error ? err.message : String(err);
      run(
        `INSERT INTO discovery_queries (client_id, type, provider, query, error)
         VALUES (?, ?, ?, ?, ?)`,
        cfg.id,
        opts.type,
        provider.id,
        q.query,
        message.slice(0, 500),
      );
      log.error(`search failed: ${message}`);
      // A missing key or an exhausted quota fails identically for every query.
      if (/no search provider|401|403|quota/i.test(message)) break;
      continue;
    }

    stats.results += results.length;
    let newForQuery = 0;

    for (const r of results) {
      const domain = domainOf(r.url);
      if (!domain) continue;

      if (opts.expandLists && looksLikeListicle(r) && !isJunk(domain, clientDomain)) {
        // The listicle itself is not a candidate; its links are.
        const expanded = await expandListicle(r, opts.type, clientDomain);
        stats.listiclesExpanded++;
        stats.candidatesNew += expanded.added;
        stats.candidatesKnown += expanded.known;
        newForQuery += expanded.added;
        continue;
      }

      if (isJunk(domain, clientDomain)) continue;

      const outcome = addCandidate(domain, opts.type, `${provider.id}:${q.id}`, `https://${domain}/`);
      if (outcome === 'new') {
        stats.candidatesNew++;
        newForQuery++;
      } else {
        stats.candidatesKnown++;
      }
    }

    run(
      `INSERT INTO discovery_queries (client_id, type, provider, query, results, new_sites)
       VALUES (?, ?, ?, ?, ?, ?)`,
      cfg.id,
      opts.type,
      provider.id,
      q.query,
      results.length,
      newForQuery,
    );
    log.info(`[${q.id}] ${results.length} results → ${newForQuery} new`);
  }

  return stats;
}

async function expandListicle(
  r: SearchResult,
  type: SubmissionType,
  clientDomain: string | null,
): Promise<{ added: number; known: number }> {
  if (!(await allowedToFetch(r.url))) {
    log.debug(`listicle skipped (robots): ${r.url}`);
    return { added: 0, known: 0 };
  }

  const res = await politeFetch(r.url);
  if (!res.html) return { added: 0, known: 0 };

  const domains = extractCandidateDomains(res.html, res.finalUrl);
  let added = 0;
  let known = 0;

  for (const domain of domains) {
    if (isJunk(domain, clientDomain)) continue;
    if (addCandidate(domain, type, `listicle:${r.url}`) === 'new') added++;
    else known++;
  }

  log.info(`listicle ${r.url} → ${added} new of ${domains.length} domains`);
  return { added, known };
}

/** Adds one domain by hand, for a site you already know you want. */
export function addManual(url: string, type: SubmissionType): { domain: string; outcome: string } {
  const domain = domainOf(url);
  if (!domain) throw new Error(`Cannot read a domain from "${url}".`);
  const outcome = addCandidate(domain, type, 'manual', /^https?:\/\//i.test(url) ? url : undefined);
  return { domain, outcome };
}

/** What discovery has cost and produced lately. */
export function harvestHistory(limit = 20) {
  return all<{
    ran_at: string;
    type: string;
    provider: string;
    query: string;
    results: number;
    new_sites: number;
    error: string | null;
  }>(
    `SELECT ran_at, type, provider, query, results, new_sites, error
       FROM discovery_queries ORDER BY ran_at DESC LIMIT ?`,
    limit,
  );
}
