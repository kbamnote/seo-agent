/**
 * Scoring rubric.
 *
 * Two separate questions, deliberately kept apart:
 *
 *   1. Should this site be rejected outright? — a parked domain, a link-farm
 *      CMS, a noindex page or a robots.txt that says no. No score saves those.
 *   2. How good is the rest? — 0-100, built from what the page actually shows.
 *
 * The score is not multiplied by the category's link-value weight here. That
 * weight belongs to *selection* (which site to use next), not to the site's own
 * quality: a good directory is a good directory even though directories matter
 * less than guest posts.
 */

import type { SubmissionType } from '../config.ts';
import type { PageSignals } from './analyse.ts';
import type { FetchResult } from './fetch.ts';

export interface ScoreInput {
  fetch: FetchResult;
  signals: PageSignals | null;
  robotsAllowed: boolean;
  type: SubmissionType | null;
}

/**
 * `reject` is permanent and about the site itself. `blocked` is about *our
 * crawler* being turned away — bot protection, or a robots.txt that forbids
 * crawling. Those two are not the same thing, and conflating them throws away
 * perfectly good platforms: robots.txt governs crawlers, not a signed-in person
 * posting through a browser, which is what Phase 3 actually does.
 */
export type Verdict = 'ok' | 'marginal' | 'blocked' | 'reject';

export interface ScoreOutput {
  score: number;
  verdict: Verdict;
  reason: string | null;
  reasons: string[];
}

const reject = (reason: string, why: string): ScoreOutput => ({
  score: 0,
  verdict: 'reject',
  reason,
  reasons: [why],
});

const blocked = (reason: string, why: string): ScoreOutput => ({
  score: 0,
  verdict: 'blocked',
  reason,
  reasons: [why],
});

const UPLOAD_TYPES: SubmissionType[] = ['pdf', 'ppt', 'image'];
const ACCEPTED_LANGS = ['en', 'hi'];

export function scoreSite(input: ScoreInput): ScoreOutput {
  const { fetch: res, signals, robotsAllowed, type } = input;
  const reasons: string[] = [];

  // ── Turned away, but not a bad site ────────────────────────────────────────
  if (!robotsAllowed) {
    return blocked(
      'robots_disallow',
      'robots.txt forbids crawling, so the page cannot be vetted automatically. ' +
        'This says nothing about posting there as a signed-in user.',
    );
  }
  if (res.status === 0) {
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME/i.test(res.error ?? '');
    return dns
      ? reject('dead_domain', `domain does not resolve (${res.error})`)
      : blocked('unreachable', `fetch failed: ${res.error ?? 'no response'} — may be transient`);
  }
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    return blocked(
      'bot_protection',
      `HTTP ${res.status}${signals?.captchaVendor ? ` with ${signals.captchaVendor}` : ''} — ` +
        'the platform refuses automated fetches. Needs a browser session, not a crawler.',
    );
  }
  if (res.status >= 500) {
    return blocked('server_error', `HTTP ${res.status} — may be transient`);
  }

  // ── Permanent rejects ──────────────────────────────────────────────────────
  if (res.status >= 400) return reject('http_error', `HTTP ${res.status}`);
  if (!signals) return reject('no_html', `no parseable HTML (${res.contentType || 'unknown type'})`);
  if (signals.parked) return reject('parked_domain', 'domain is parked or for sale');
  if (signals.farmSignatures.length) {
    return reject('link_farm_cms', `runs a link-farm platform: ${signals.farmSignatures.join(', ')}`);
  }
  if (signals.noindex) {
    return reject('noindex', 'page is noindex — a link Google will not index passes nothing');
  }
  if (signals.externalLinks > 500) {
    return reject('link_farm_volume', `${signals.externalLinks} outbound links on one page`);
  }

  // ── Score ──────────────────────────────────────────────────────────────────
  let score = 40;
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${n >= 0 ? '+' : ''}${n} ${why}`);
  };

  if (res.status === 200) add(10, 'responds 200');
  if (res.finalUrl.startsWith('https://')) add(5, 'https');
  else add(-5, 'http only');

  if (signals.hasSubmitAffordance) add(10, 'has a submission entry point');
  else add(-10, 'no submission entry point found on the homepage');

  if (signals.hasSignupAffordance) add(5, 'has signup');
  if (signals.hasUrlField) add(5, 'a form takes a URL');
  if (signals.hasFileInput && type && UPLOAD_TYPES.includes(type)) add(5, 'accepts file upload');
  if (!signals.hasFileInput && type && UPLOAD_TYPES.includes(type)) {
    add(-10, `no upload field, but ${type} needs one`);
  }

  const nf = signals.nofollowRatio;
  if (nf === null) add(0, 'no external links to judge rel from');
  else if (nf <= 0.2) add(15, 'outbound links are mostly dofollow');
  else if (nf <= 0.8) add(5, 'mixed dofollow and nofollow');
  else add(-10, 'outbound links are almost all nofollow');

  const ext = signals.externalLinks;
  if (ext <= 50) add(5, `${ext} outbound links`);
  else if (ext <= 150) add(0, `${ext} outbound links`);
  else if (ext <= 300) add(-10, `${ext} outbound links — getting farm-like`);
  else add(-20, `${ext} outbound links — farm-like`);

  if (signals.wordCount < 120) add(-10, 'almost no text on the page');
  if (!signals.title) add(-5, 'no title tag');

  if (signals.language && !ACCEPTED_LANGS.includes(signals.language.slice(0, 2))) {
    add(-10, `page language is ${signals.language}`);
  }
  if (signals.captchaVendor) add(-5, `${signals.captchaVendor} present — needs Assist Mode`);

  const final = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: final,
    // A low score is not a rejection. The homepage is a poor witness: plenty of
    // working platforms put nothing identifiable on it. `marginal` means "no
    // evidence either way", and an adapter or a human can overrule it.
    verdict: final >= 45 ? 'ok' : 'marginal',
    reason: final >= 45 ? null : `low_submittability_${final}`,
    reasons,
  };
}

/**
 * Human-readable band. This describes **submittability** — how mechanically
 * workable the site is — not authority. A spotless bookmarking farm can score
 * 90 here; see authority.ts for whether a link from it is worth anything.
 */
export function scoreBand(score: number): string {
  if (score >= 75) return 'easy to submit to';
  if (score >= 60) return 'workable';
  if (score >= 45) return 'awkward';
  return 'no evidence';
}
