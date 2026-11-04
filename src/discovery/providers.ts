/**
 * Web search, provider-independent.
 *
 * Same principle as the LLM driver: one interface, vendor chosen by env, so a
 * quota change or a price rise is a config edit. Three real providers plus
 * `none`, which fails with instructions rather than silently returning nothing.
 *
 * Deliberately not included: scraping Google's result pages with a headless
 * browser. It breaks their terms, trips CAPTCHAs within a few dozen queries,
 * and the whole point of this module is a dependable candidate stream.
 */

import { log } from '../util/log.ts';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  readonly id: string;
  /** Results per call is capped by the vendor; `count` is a request, not a promise. */
  search(query: string, count: number): Promise<SearchResult[]>;
}

const UA = 'TapifySeoAgent/0.1 (+https://tapify.co.in)';

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json() as Promise<any>;
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json() as Promise<any>;
}

/** Serper.dev — Google results, pay per call, 2500 free to start. */
class SerperProvider implements SearchProvider {
  readonly id = 'serper';
  constructor(private key: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const data = await postJson(
      'https://google.serper.dev/search',
      { q: query, num: Math.min(count, 100), gl: 'in', hl: 'en' },
      { 'X-API-KEY': this.key },
    );
    return (data.organic ?? []).map((r: any) => ({
      url: String(r.link ?? ''),
      title: String(r.title ?? ''),
      snippet: String(r.snippet ?? ''),
    }));
  }
}

/** Google Programmable Search — free 100 queries/day, 10 results per call. */
class GoogleCseProvider implements SearchProvider {
  readonly id = 'google_cse';
  constructor(
    private key: string,
    private cx: string,
  ) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const out: SearchResult[] = [];
    // The API hard-caps at 10 per request and 100 total; page until satisfied.
    for (let start = 1; out.length < count && start <= 91; start += 10) {
      const url =
        'https://www.googleapis.com/customsearch/v1' +
        `?key=${encodeURIComponent(this.key)}&cx=${encodeURIComponent(this.cx)}` +
        `&q=${encodeURIComponent(query)}&num=10&start=${start}`;
      const data = await getJson(url);
      const items = data.items ?? [];
      if (!items.length) break;
      for (const r of items) {
        out.push({
          url: String(r.link ?? ''),
          title: String(r.title ?? ''),
          snippet: String(r.snippet ?? ''),
        });
      }
    }
    return out.slice(0, count);
  }
}

/** Brave Search API — generous free tier, independent index. */
class BraveProvider implements SearchProvider {
  readonly id = 'brave';
  constructor(private key: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const url =
      'https://api.search.brave.com/res/v1/web/search' +
      `?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}&country=in`;
    const data = await getJson(url, { 'X-Subscription-Token': this.key });
    return (data.web?.results ?? []).map((r: any) => ({
      url: String(r.url ?? ''),
      title: String(r.title ?? ''),
      snippet: String(r.description ?? ''),
    }));
  }
}

class NoProvider implements SearchProvider {
  readonly id = 'none';
  async search(): Promise<SearchResult[]> {
    throw new Error(
      'No search provider configured, so there is nothing to harvest from.\n' +
        'Either seed the catalog from the curated list, which needs no key:\n' +
        '  npm run discover:seed -- --client <id>\n' +
        'or set one of these in .env:\n' +
        '  SEARCH_PROVIDER=serper      SERPER_API_KEY=...        (serper.dev, pay per call)\n' +
        '  SEARCH_PROVIDER=google_cse  GOOGLE_CSE_KEY=... GOOGLE_CSE_CX=...  (100/day free)\n' +
        '  SEARCH_PROVIDER=brave       BRAVE_API_KEY=...         (free tier)',
    );
  }
}

/** Picks the provider from env, or the first one that has a key. */
export function getSearchProvider(explicit?: string): SearchProvider {
  const want = (explicit || process.env.SEARCH_PROVIDER || '').trim().toLowerCase();
  const serper = process.env.SERPER_API_KEY?.trim();
  const cseKey = process.env.GOOGLE_CSE_KEY?.trim();
  const cseCx = process.env.GOOGLE_CSE_CX?.trim();
  const brave = process.env.BRAVE_API_KEY?.trim();

  const build = (id: string): SearchProvider | null => {
    if (id === 'serper' && serper) return new SerperProvider(serper);
    if (id === 'google_cse' && cseKey && cseCx) return new GoogleCseProvider(cseKey, cseCx);
    if (id === 'brave' && brave) return new BraveProvider(brave);
    return null;
  };

  if (want && want !== 'none') {
    const chosen = build(want);
    if (chosen) return chosen;
    log.warn(`SEARCH_PROVIDER=${want} but its key is missing; falling back.`);
  }

  for (const id of ['serper', 'google_cse', 'brave']) {
    const chosen = build(id);
    if (chosen) {
      if (!want) log.info(`search provider: ${id} (auto-selected)`);
      return chosen;
    }
  }
  return new NoProvider();
}
