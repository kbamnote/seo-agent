/**
 * Polite HTTP fetching for vetting and verification.
 *
 * Three things matter here and nothing else does: identify ourselves honestly,
 * never hammer one host, and never hang. A vetting pass touches a few hundred
 * strangers' servers; behaving well is both the right thing and the reason the
 * agent does not end up IP-banned by the platforms it depends on.
 */

import { log } from '../util/log.ts';

export const USER_AGENT = 'TapifySeoAgent/0.1 (+https://tapify.co.in; site vetting)';

const MIN_HOST_INTERVAL_MS = Number(process.env.FETCH_HOST_INTERVAL_MS) || 1500;
const MAX_BYTES = 2_000_000;

const lastHit = new Map<string, number>();
const hostQueue = new Map<string, Promise<void>>();

export interface FetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  html: string;
  error?: string;
  elapsedMs: number;
  truncated: boolean;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Serialises the *start* of requests per host and keeps MIN_HOST_INTERVAL_MS
 * between them. Each caller chains onto the last one for that host, so twenty
 * parallel workers hitting the same domain still arrive one at a time.
 */
function throttle(host: string): Promise<void> {
  const prior = hostQueue.get(host) ?? Promise.resolve();
  const mine = prior.then(async () => {
    const since = Date.now() - (lastHit.get(host) ?? 0);
    if (since < MIN_HOST_INTERVAL_MS) await sleep(MIN_HOST_INTERVAL_MS - since);
    lastHit.set(host, Date.now());
  });
  // Swallow rejections in the chain so one failure cannot poison the host queue.
  hostQueue.set(host, mine.catch(() => undefined));
  return mine;
}

export async function politeFetch(
  url: string,
  opts: { timeoutMs?: number; method?: 'GET' | 'HEAD'; accept?: string } = {},
): Promise<FetchResult> {
  const started = Date.now();
  const blank: FetchResult = {
    ok: false,
    status: 0,
    finalUrl: url,
    contentType: '',
    html: '',
    elapsedMs: 0,
    truncated: false,
  };

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ...blank, error: 'invalid_url', elapsedMs: Date.now() - started };
  }

  await throttle(host);

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.accept ?? 'text/html,application/xhtml+xml',
        'accept-language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });

    const contentType = res.headers.get('content-type') ?? '';
    let html = '';
    let truncated = false;

    if (opts.method !== 'HEAD' && /text\/|xml|json/i.test(contentType)) {
      const buf = await res.arrayBuffer();
      truncated = buf.byteLength > MAX_BYTES;
      html = new TextDecoder('utf-8', { fatal: false }).decode(
        truncated ? buf.slice(0, MAX_BYTES) : buf,
      );
    }

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      html,
      elapsedMs: Date.now() - started,
      truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`fetch failed ${url}: ${message}`);
    return {
      ...blank,
      error: /timeout|abort/i.test(message) ? 'timeout' : message.slice(0, 200),
      elapsedMs: Date.now() - started,
    };
  }
}

/** Runs tasks with a concurrency cap. Order of results matches input. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
