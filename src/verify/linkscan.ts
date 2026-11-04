/**
 * Finding the client's link on a page, and saying exactly what it is.
 *
 * The distinction this module exists to make: a **link** is an `<a href>` that
 * points at the client. A **mention** is the client's URL appearing as plain
 * text. The old tracker counted both as "Approved", and they are not remotely
 * the same thing — a mention passes nothing at all.
 *
 * It also records `rel`, because a nofollow link and a dofollow link are
 * different products, and the sheet never recorded which it got.
 */

import * as cheerio from 'cheerio';

export interface FoundLink {
  href: string;
  anchorText: string;
  rel: string[];
  /** Follow status as the page declares it. */
  follow: 'dofollow' | 'nofollow' | 'ugc' | 'sponsored';
  /** Inside article/main rather than a nav or footer. */
  inContent: boolean;
}

export interface LinkScan {
  links: FoundLink[];
  /** The URL appears as text but not as a link. */
  mentionOnly: boolean;
  /** Best link found, preferring dofollow and in-content. */
  best: FoundLink | null;
  totalLinks: number;
}

function hostOf(url: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Same registrable site, so eeetechnologies.in matches www. and blog. */
function sameSite(candidate: string, clientHost: string): boolean {
  return candidate === clientHost || candidate.endsWith(`.${clientHost}`);
}

function followOf(rel: string[]): FoundLink['follow'] {
  if (rel.includes('nofollow')) return 'nofollow';
  if (rel.includes('sponsored')) return 'sponsored';
  if (rel.includes('ugc')) return 'ugc';
  return 'dofollow';
}

export function scanForLink(html: string, pageUrl: string, clientSiteUrl: string): LinkScan {
  const clientHost = hostOf(clientSiteUrl);
  const scan: LinkScan = { links: [], mentionOnly: false, best: null, totalLinks: 0 };
  if (!clientHost || !html) return scan;

  const $ = cheerio.load(html);
  const contentScope = $('article, main, .post-content, .entry-content, [role="main"]');

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') ?? '').trim();
    if (!href) return;

    let resolved: string;
    try {
      resolved = new URL(href, pageUrl).toString();
    } catch {
      return;
    }

    const host = hostOf(resolved);
    if (!host || !sameSite(host, clientHost)) return;

    const rel = ($a.attr('rel') ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    scan.links.push({
      href: resolved,
      anchorText: $a.text().replace(/\s+/g, ' ').trim().slice(0, 200),
      rel,
      follow: followOf(rel),
      inContent: contentScope.length > 0 ? contentScope.find(`a[href="${href}"]`).length > 0 : true,
    });
  });

  scan.totalLinks = $('a[href]').length;

  if (!scan.links.length) {
    // No anchor, but is the URL sitting there as text? That is a mention.
    const text = $('body').text();
    scan.mentionOnly = text.includes(clientHost);
  }

  // Prefer a dofollow in-content link; that is the one worth reporting.
  scan.best =
    [...scan.links].sort((a, b) => {
      const score = (l: FoundLink) => (l.follow === 'dofollow' ? 2 : 0) + (l.inContent ? 1 : 0);
      return score(b) - score(a);
    })[0] ?? null;

  return scan;
}

/**
 * Does this page look like it needs JavaScript to show its content?
 *
 * Flipboard, Padlet and Substack notes render client-side, so a plain fetch
 * returns a shell with no link in it — which would read as "the link is gone"
 * when it is simply not in the HTML yet. When this is true the verifier retries
 * with a real browser before concluding anything.
 */
export function looksClientRendered(html: string): boolean {
  if (!html) return true;
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const anchors = $('a[href]').length;

  if (text.length < 500 && anchors < 5) return true;
  if (/<div id="(root|app|__next)"[^>]*>\s*<\/div>/i.test(html)) return true;
  if (/\b(enable javascript|requires javascript)\b/i.test(text)) return true;
  return false;
}
