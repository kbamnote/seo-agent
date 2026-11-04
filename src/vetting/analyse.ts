/**
 * Turns a fetched HTML page into the signals the scorer needs.
 *
 * Everything here is observable fact about the page. Judgement lives in
 * score.ts, so a change of opinion about what matters never means re-crawling.
 */

import * as cheerio from 'cheerio';
import { domainOf } from '../sheets/schema.ts';

export interface PageSignals {
  title: string;
  metaDescription: string;
  language: string | null;
  noindex: boolean;

  /** Submission affordances. */
  hasSignupAffordance: boolean;
  hasSubmitAffordance: boolean;
  submitCandidates: string[];
  formCount: number;
  hasTextarea: boolean;
  hasFileInput: boolean;
  hasUrlField: boolean;

  captchaVendor: string | null;

  /** Outbound link profile of the sampled page. */
  externalLinks: number;
  externalDomains: number;
  nofollowExternal: number;
  nofollowRatio: number | null;

  farmSignatures: string[];
  parked: boolean;
  wordCount: number;

  /**
   * Anchor text of internal content links — on a bookmarking site these are the
   * submitted story titles. The single most revealing thing on the page: a farm
   * shows bearing exporters next to visa consultants next to escort ads, and no
   * mechanical signal catches that.
   */
  contentTitles: string[];
}

const SIGNUP_PATTERNS = /\b(sign ?up|register|create account|join( now| free)?|create profile)\b/i;
const SUBMIT_PATTERNS =
  /\b(submit (a )?(story|site|link|url|article|guest post|business|listing)|add (your )?(site|url|link|business|listing|story)|write for us|contribute|post (a )?(story|link)|new story|upload)\b/i;

const CAPTCHA_SIGNATURES: Array<[vendor: string, test: RegExp]> = [
  ['recaptcha', /recaptcha\/(api|enterprise)|g-recaptcha/i],
  ['hcaptcha', /hcaptcha\.com|h-captcha/i],
  ['turnstile', /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i],
  ['cloudflare-challenge', /cdn-cgi\/challenge-platform|__cf_chl/i],
  ['funcaptcha', /funcaptcha|arkoselabs/i],
];

/**
 * Platform fingerprints of the link-farm CMSs. A site running one of these is
 * a bookmarking farm by definition: thousands of outbound links, no editorial
 * control, and usually deindexed.
 */
const FARM_SIGNATURES: Array<[name: string, test: RegExp]> = [
  ['pligg', /pligg/i],
  ['phpdug', /phpdug/i],
  ['kliqqi', /kliqqi/i],
  ['scuttle', /scuttle/i],
  ['article-directory', /article (directory|dashboard)|submit your article/i],
  ['ffa-links', /free for all links/i],
];

const PARKED_SIGNATURES =
  /\b(domain (is )?(for sale|parked)|buy this domain|this domain may be for sale|parkingcrew|sedoparking)\b/i;

export function analysePage(html: string, pageUrl: string): PageSignals {
  const $ = cheerio.load(html);
  const selfDomain = domainOf(pageUrl);

  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const anchors = $('a[href]').toArray();

  let externalLinks = 0;
  let nofollowExternal = 0;
  const externalDomains = new Set<string>();
  const submitCandidates = new Set<string>();
  const contentTitles = new Set<string>();

  for (const el of anchors) {
    const $a = $(el);
    const href = ($a.attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;

    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;

    const label = `${$a.text()} ${$a.attr('title') ?? ''}`.replace(/\s+/g, ' ').trim();
    if (SUBMIT_PATTERNS.test(label) || SUBMIT_PATTERNS.test(abs.pathname.replace(/[-_/]/g, ' '))) {
      submitCandidates.add(abs.toString());
    }

    if (
      domainOf(abs.toString()) === selfDomain &&
      CONTENT_PATH.test(abs.pathname) &&
      !NOT_CONTENT.test(abs.pathname) &&
      label.length > 15
    ) {
      contentTitles.add(label.slice(0, 160));
    }

    const domain = domainOf(abs.toString());
    if (domain && domain !== selfDomain) {
      externalLinks++;
      externalDomains.add(domain);
      const rel = ($a.attr('rel') ?? '').toLowerCase();
      if (/\b(nofollow|ugc|sponsored)\b/.test(rel)) nofollowExternal++;
    }
  }

  const head = $.html().slice(0, 400_000);
  const captcha = CAPTCHA_SIGNATURES.find(([, re]) => re.test(head));
  const generator = $('meta[name="generator"]').attr('content') ?? '';
  const farmHaystack = `${generator} ${$('footer').text()} ${$('title').text()}`;

  const robotsMeta = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();

  const allLabels = anchors
    .map((el) => $(el).text())
    .join(' ')
    .replace(/\s+/g, ' ');

  return {
    title: ($('title').first().text() ?? '').trim().slice(0, 300),
    metaDescription: ($('meta[name="description"]').attr('content') ?? '').trim().slice(0, 500),
    language: ($('html').attr('lang') ?? '').trim().toLowerCase() || null,
    noindex: /\bnoindex\b/.test(robotsMeta),

    hasSignupAffordance: SIGNUP_PATTERNS.test(allLabels) || SIGNUP_PATTERNS.test(text.slice(0, 5000)),
    hasSubmitAffordance: submitCandidates.size > 0 || SUBMIT_PATTERNS.test(allLabels),
    submitCandidates: [...submitCandidates].slice(0, 10),

    formCount: $('form').length,
    hasTextarea: $('textarea').length > 0,
    hasFileInput: $('input[type="file"]').length > 0,
    hasUrlField:
      $('input[type="url"]').length > 0 ||
      $('input[name*="url" i], input[name*="link" i], input[name*="website" i]').length > 0,

    captchaVendor: captcha ? captcha[0] : null,

    externalLinks,
    externalDomains: externalDomains.size,
    nofollowExternal,
    nofollowRatio: externalLinks > 0 ? Number((nofollowExternal / externalLinks).toFixed(3)) : null,

    farmSignatures: FARM_SIGNATURES.filter(([, re]) => re.test(farmHaystack) || re.test(head)).map(
      ([name]) => name,
    ),
    parked: PARKED_SIGNATURES.test(text.slice(0, 3000)) || PARKED_SIGNATURES.test($('title').text()),
    wordCount: text ? text.split(/\s+/).length : 0,
    contentTitles: [...contentTitles].slice(0, 12),
  };
}

/**
 * Picks one inner content page to sample.
 *
 * A homepage is a bad witness. Bookmarking farms keep theirs tidy — few
 * outbound links, a clean "submit a story" button — and put the thousand
 * outbound links, or a noindex, on the story pages where the actual submissions
 * land. One extra fetch per site is what it costs to see that.
 */
const CONTENT_PATH =
  /\/(story|stories|item|items|post|posts|article|articles|submission|news|user|users|profile|p|annotated|link)\b/i;
const NOT_CONTENT =
  /\/(login|signin|sign-in|signup|sign-up|register|submit|add|about|contact|privacy|terms|faq|help|pricing|cart|search|tag|tags|category|categories|page)\b/i;

export function pickSamplePage(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  const self = domainOf(pageUrl);
  const scored: Array<{ url: string; depth: number }> = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || href.startsWith('#')) return;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(abs.protocol)) return;
    if (domainOf(abs.toString()) !== self) return;
    const path = abs.pathname;
    if (path === '/' || NOT_CONTENT.test(path)) return;
    if (!CONTENT_PATH.test(path)) return;
    scored.push({ url: abs.toString(), depth: path.split('/').filter(Boolean).length });
  });

  if (!scored.length) return null;
  // Deepest path first: that is where real content lives.
  scored.sort((a, b) => b.depth - a.depth);
  return scored[0]!.url;
}

/**
 * Combines homepage and inner-page signals, keeping the *worse* of the two for
 * anything that reveals a farm. Submission affordances stay as the homepage saw
 * them, since that is where they belong.
 */
export function mergeWorst(home: PageSignals, inner: PageSignals): PageSignals {
  return {
    ...home,
    noindex: home.noindex || inner.noindex,
    parked: home.parked || inner.parked,
    farmSignatures: [...new Set([...home.farmSignatures, ...inner.farmSignatures])],
    externalLinks: Math.max(home.externalLinks, inner.externalLinks),
    externalDomains: Math.max(home.externalDomains, inner.externalDomains),
    nofollowExternal: Math.max(home.nofollowExternal, inner.nofollowExternal),
    // The inner page's rel profile is the one that matters: that is the page a
    // submission actually lands on.
    nofollowRatio: inner.nofollowRatio ?? home.nofollowRatio,
    wordCount: Math.max(home.wordCount, inner.wordCount),
    contentTitles: [...new Set([...home.contentTitles, ...inner.contentTitles])].slice(0, 12),
  };
}

/** Pulls outbound domains out of a listicle ("Top 50 bookmarking sites"). */
export function extractCandidateDomains(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const self = domainOf(pageUrl);
  const found = new Set<string>();

  // Listicles put the sites in the body, and the chrome (nav, footer, share
  // buttons) in everything else. Prefer the content containers when present.
  const scope = $('article, main, .entry-content, .post-content').length
    ? $('article, main, .entry-content, .post-content')
    : $('body');

  scope.find('a[href^="http"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const domain = domainOf(href);
    if (domain && domain !== self) found.add(domain);
  });

  return [...found];
}
