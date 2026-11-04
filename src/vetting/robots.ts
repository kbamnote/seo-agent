/**
 * Minimal robots.txt parser.
 *
 * The agent respects robots.txt for its own crawling, and a site whose
 * robots.txt disallows the submission path is rejected rather than worked
 * around. That is a design choice, not an oversight: a link placed against a
 * site's stated wishes is a link that gets removed, and the account with it.
 *
 * Implements the parts that matter — user-agent groups, Allow, Disallow,
 * longest-match-wins with Allow breaking ties, and * / $ wildcards.
 */

import { politeFetch } from './fetch.ts';

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  origin: string;
  fetched: boolean;
  status: number;
  rules: Rule[]; // for the most specific matching group
  crawlDelayMs: number | null;
  sitemaps: string[];
}

const cache = new Map<string, Robots>();
const OUR_AGENT = 'tapifyseoagent';

export async function getRobots(url: string): Promise<Robots> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { origin: url, fetched: false, status: 0, rules: [], crawlDelayMs: null, sitemaps: [] };
  }

  const hit = cache.get(origin);
  if (hit) return hit;

  const res = await politeFetch(`${origin}/robots.txt`, { accept: 'text/plain', timeoutMs: 12_000 });
  const robots = parseRobots(origin, res.status, res.html);
  cache.set(origin, robots);
  return robots;
}

export function parseRobots(origin: string, status: number, body: string): Robots {
  const out: Robots = {
    origin,
    // A 404 means "nothing is forbidden"; anything else unparsed means the same
    // for our purposes, because we only ever use this to avoid being rude.
    fetched: status === 200,
    status,
    rules: [],
    crawlDelayMs: null,
    sitemaps: [],
  };
  if (status !== 200 || !body) return out;

  // Group agents until the first directive, so "User-agent: a\nUser-agent: b"
  // shares one rule block as the spec requires.
  const groups: Array<{ agents: string[]; rules: Rule[]; crawlDelay: number | null }> = [];
  let current: (typeof groups)[number] | null = null;
  let collectingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'sitemap') {
      out.sitemaps.push(value);
      continue;
    }

    collectingAgents = false;
    if (!current) continue;

    if (field === 'disallow') current.rules.push({ allow: false, pattern: value });
    else if (field === 'allow') current.rules.push({ allow: true, pattern: value });
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n * 1000;
    }
  }

  // Most specific group wins: our own name, then *, then nothing.
  const named = groups.find((g) => g.agents.some((a) => OUR_AGENT.includes(a) && a !== '*'));
  const star = groups.find((g) => g.agents.includes('*'));
  const chosen = named ?? star;
  if (chosen) {
    out.rules = chosen.rules;
    out.crawlDelayMs = chosen.crawlDelay;
  }
  return out;
}

function toRegex(pattern: string): RegExp {
  // Escape everything, then restore the two wildcards robots.txt defines.
  let body = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  let anchorEnd = false;
  if (body.endsWith('%24')) body = body.slice(0, -3) + '$'; // paranoia: encoded $
  if (body.endsWith('\\$')) {
    body = body.slice(0, -2);
    anchorEnd = true;
  }
  return new RegExp(`^${body}${anchorEnd ? '$' : ''}`);
}

/** robots.txt verdict for a path. An empty Disallow value allows everything. */
export function isAllowed(robots: Robots, pathWithQuery: string): boolean {
  if (!robots.rules.length) return true;

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    if (rule.pattern === '') {
      // "Disallow:" with no value is an explicit allow-all, lowest precedence.
      if (!best) best = { allow: true, length: 0 };
      continue;
    }
    if (!toRegex(rule.pattern).test(pathWithQuery)) continue;
    const length = rule.pattern.length;
    // Longest match wins; Allow wins a tie.
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

export async function allowedToFetch(url: string): Promise<boolean> {
  const robots = await getRobots(url);
  try {
    const u = new URL(url);
    return isAllowed(robots, u.pathname + u.search);
  } catch {
    return false;
  }
}
