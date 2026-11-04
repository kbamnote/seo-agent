/**
 * Verifying one submitted URL.
 *
 * This is the module the whole project exists to make possible. Everything
 * before it produces claims; this is the only thing that produces evidence.
 *
 * Four honest outcomes, and the middle two matter most:
 *   - the link is there              → verified
 *   - the page is fine, no link      → pending moderation, or quietly removed
 *   - our fetcher was refused (403)  → unknown, NOT gone
 *   - the page returns 404/410       → lost
 *
 * The old tracker could not tell any of these apart, which is why 15 of its
 * rows said "Approved" with nothing to show.
 */

import type { Browser } from 'playwright';
import { politeFetch } from '../vetting/fetch.ts';
import { openSession } from '../submit/browser.ts';
import { checkIndexed } from '../vetting/authority.ts';
import { log } from '../util/log.ts';
import { looksClientRendered, scanForLink, type LinkScan } from './linkscan.ts';

export interface VerifyResult {
  httpStatus: number;
  finalUrl: string;
  redirected: boolean;
  linkPresent: boolean;
  mentionOnly: boolean;
  follow: string | null;
  anchorFound: string | null;
  inContent: boolean | null;
  indexed: boolean | null;
  method: 'fetch' | 'browser';
  /** True when we could not see the page at all — never counts as "gone". */
  inconclusive: boolean;
  note: string;
}

/**
 * One browser for the whole verification run, not one per URL.
 *
 * The fallback fires on every URL where a plain fetch found no link, which is
 * most of them on JS-rendered platforms, and eighteen Chromium launches is a
 * minute of pure overhead.
 */
let shared: Browser | null = null;

async function browser(): Promise<Browser | null> {
  if (shared) return shared;
  try {
    const { chromium } = await import('playwright');
    shared = await chromium.launch({ headless: true });
    return shared;
  } catch (err) {
    log.warn(`no browser available for rendering: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function closeVerifyBrowser(): Promise<void> {
  if (shared) {
    await shared.close().catch(() => undefined);
    shared = null;
  }
}

async function render(
  url: string,
  sessionDomain?: string,
): Promise<{ html: string; finalUrl: string; status: number } | null> {
  // Through the client's own persistent profile, when asked.
  if (sessionDomain) {
    try {
      const session = await openSession(sessionDomain);
      const page = session.page;
      page.setDefaultTimeout(25_000);
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      return { html: await page.content(), finalUrl: page.url(), status: res?.status() ?? 0 };
    } catch (err) {
      log.debug(`session render failed for ${url}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  const b = await browser();
  if (!b) return null;

  const context = await b.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    // Client-rendered feeds need a moment after DOM ready to paint their content.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    return { html: await page.content(), finalUrl: page.url(), status: res?.status() ?? 0 };
  } catch (err) {
    log.debug(`render failed for ${url}: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** The tracker holds scheme-less URLs like `buymeacoffee.com/eeetechnology`. */
export function normaliseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** Always render, instead of only when a plain fetch finds nothing. */
  deep?: boolean;
  /** Spend one search call to check the backlink page is indexed. */
  checkIndex?: boolean;
  /**
   * Render through the persistent session profile for this domain instead of a
   * throwaway headless context.
   *
   * Nine of the eighteen imported links came back 403 to headless Chromium —
   * Substack, Flipboard, Padlet, Diigo, start.me. The answer is not to disguise
   * the browser; it is to use the real one. A session profile runs headful (per
   * HEADLESS in .env) and carries the client's own logged-in cookies, which is
   * exactly how a person would look at the page.
   */
  sessionDomain?: string;
}

const EMPTY_SCAN: LinkScan = { links: [], mentionOnly: false, best: null, totalLinks: 0 };

export async function verifyUrl(
  rawUrl: string,
  clientSiteUrl: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const url = normaliseUrl(rawUrl);
  const result: VerifyResult = {
    httpStatus: 0,
    finalUrl: url ?? rawUrl,
    redirected: false,
    linkPresent: false,
    mentionOnly: false,
    follow: null,
    anchorFound: null,
    inContent: null,
    indexed: null,
    method: 'fetch',
    inconclusive: false,
    note: '',
  };

  if (!url) {
    result.inconclusive = true;
    result.note = `"${rawUrl}" is not a usable URL`;
    return result;
  }

  let html = '';
  let scan: LinkScan = EMPTY_SCAN;

  if (!opts.deep) {
    const res = await politeFetch(url);
    result.httpStatus = res.status;
    result.finalUrl = res.finalUrl || url;
    result.redirected = result.finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, '');
    html = res.html;

    // 404 and 410 mean gone. 403, 429 and 5xx mean *we* were refused, which is
    // the mistake this project already made once in vetting: a platform
    // blocking a crawler says nothing about whether the page exists.
    if (res.status === 404 || res.status === 410) {
      result.note = `HTTP ${res.status} — the page is gone`;
      return result;
    }

    if (res.status && res.status < 400) {
      scan = scanForLink(html, result.finalUrl, clientSiteUrl);
    }
  }

  // Render when asked, when the fetch found no link, or when the fetch could
  // not see the page at all.
  const needsRender =
    opts.deep || !scan.links.length || result.httpStatus === 0 || result.httpStatus >= 400;

  if (needsRender) {
    const rendered = await render(url, opts.sessionDomain);
    if (rendered) {
      result.method = 'browser';
      result.finalUrl = rendered.finalUrl;
      result.redirected = rendered.finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, '');
      if (rendered.status) result.httpStatus = rendered.status;

      if (rendered.status === 404 || rendered.status === 410) {
        result.note = `HTTP ${rendered.status} — the page is gone`;
        return result;
      }
      scan = scanForLink(rendered.html, rendered.finalUrl, clientSiteUrl);
      html = rendered.html;
    } else if (!html) {
      // Neither path could see the page. Unknown, not gone.
      result.inconclusive = true;
      result.note =
        result.httpStatus >= 400
          ? `HTTP ${result.httpStatus} and rendering failed — could not see the page`
          : 'could not fetch or render the page';
      return result;
    }
  }

  // Still refused after rendering: inconclusive, never "lost".
  if (result.httpStatus === 403 || result.httpStatus === 429 || result.httpStatus >= 500) {
    result.inconclusive = true;
    result.note = `HTTP ${result.httpStatus} — the platform refused us, so the link cannot be confirmed either way`;
    return result;
  }

  result.linkPresent = scan.links.length > 0;
  result.mentionOnly = scan.mentionOnly;

  if (scan.best) {
    result.follow = scan.best.follow;
    result.anchorFound = scan.best.anchorText || '(empty anchor)';
    result.inContent = scan.best.inContent;
    result.note =
      `${scan.links.length} link${scan.links.length === 1 ? '' : 's'} to the client, ` +
      `best is ${scan.best.follow}${scan.best.inContent ? ' in content' : ' outside content'}`;
  } else if (scan.mentionOnly) {
    result.note = 'the URL appears as plain text, not as a link — this passes nothing';
  } else if (looksClientRendered(html)) {
    // Rendered and still nothing, but the page has almost no content: more
    // likely a login wall or an empty shell than a removed link.
    result.inconclusive = true;
    result.note = 'the page rendered almost no content — probably a login wall, cannot tell';
  } else {
    result.note = 'page loads and renders, but contains no link to the client';
  }

  if (opts.checkIndex) {
    try {
      const parsed = new URL(result.finalUrl);
      result.indexed = await checkIndexed(`${parsed.hostname}${parsed.pathname}`);
    } catch {
      result.indexed = null;
    }
  }

  return result;
}
