/**
 * The generic adapter: find the submission form, fill it, submit it, work out
 * what URL the thing landed on.
 *
 * This handles every platform without a hand-written adapter, which is the
 * majority. It is also the honest default — a bespoke adapter per site would be
 * a maintenance liability and most of them would be broken within months.
 */

import type { Page } from 'playwright';
import { log } from '../../util/log.ts';
import { detectChallenge, requestAssist } from '../assist.ts';
import { looksSignedOut, snapshot } from '../browser.ts';
import { fillForm, findSubmit } from '../forms.ts';
import { pageContainsLink, readPublishedUrl } from './helpers.ts';
import type { SiteAdapter, SubmitContext, SubmitOutcome } from './types.ts';

/** Paths worth trying when the catalog has no submit URL for a site. */
const SUBMIT_PATHS = [
  '/submit',
  '/submit-story',
  '/submit.php',
  '/story/submit',
  '/add',
  '/add-url',
  '/add-site',
  '/new',
  '/post',
  '/create',
];

async function findSubmissionPage(page: Page, siteDomain: string, submitUrl?: string | null): Promise<boolean> {
  const origin = `https://${siteDomain}`;

  if (submitUrl) {
    const res = await page.goto(submitUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (res && res.status() < 400) return true;
  }

  // Look for a submit link on the homepage before brute-forcing paths: a real
  // link is more likely to be right than a guessed URL.
  const home = await page.goto(origin, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (home) {
    const link = page
      .locator('a')
      .filter({ hasText: /\b(submit|add (your )?(site|url|story|link|business)|write for us|new (story|post))\b/i })
      .first();
    if ((await link.count().catch(() => 0)) > 0) {
      const href = await link.getAttribute('href').catch(() => null);
      if (href) {
        const res = await page
          .goto(new URL(href, origin).toString(), { waitUntil: 'domcontentloaded' })
          .catch(() => null);
        if (res && res.status() < 400) return true;
      }
    }
  }

  for (const path of SUBMIT_PATHS) {
    const res = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (res && res.status() < 400) {
      const forms = await page.locator('form').count().catch(() => 0);
      if (forms > 0) return true;
    }
  }
  return false;
}

export const genericAdapter: SiteAdapter = {
  id: 'generic',
  categories: ['bookmarking', 'profile', 'directory', 'blog', 'pdf', 'ppt', 'image', 'mindmap'],
  requiresAccount: true,
  confidence: 'untested',

  async submit(ctx: SubmitContext): Promise<SubmitOutcome> {
    const { page, siteDomain } = ctx;

    const found = await findSubmissionPage(page, siteDomain, ctx.submitUrl);
    if (!found) {
      return {
        status: 'failed',
        note: 'could not find a submission form',
        screenshot: await snapshot(page, siteDomain, 'no-form'),
      };
    }

    // A sign-in wall or a challenge is a job for the human, once per site.
    const challenge = await detectChallenge(page);
    const signedOut = await looksSignedOut(page);

    if (challenge || signedOut) {
      const need = challenge
        ? `Clear the ${challenge} on ${siteDomain}, and sign in if it asks.`
        : `Sign in to ${siteDomain} (or create the account), then leave the submission page open.`;

      const outcome = await requestAssist({
        domain: siteDomain,
        page,
        need:
          need +
          (ctx.account
            ? ` Username: ${ctx.account.username}. The password is in the vault — run: npm run cli -- account password ${siteDomain}`
            : ''),
        resolved: async () => !(await detectChallenge(page)) && !(await looksSignedOut(page)),
      });

      if (outcome !== 'resolved') {
        return { status: 'needs_assist', note: `waiting on ${challenge ?? 'sign-in'}` };
      }
    }

    const before = page.url();
    const report = await fillForm(page, ctx.payload);

    if (!report.filled.length) {
      return {
        status: 'failed',
        note: 'form found but no field could be mapped',
        screenshot: await snapshot(page, siteDomain, 'unmapped'),
      };
    }
    if (report.missingRequired.length) {
      log.warn(`${siteDomain}: required fields left empty: ${report.missingRequired.join(', ')}`);
    }

    const submit = await findSubmit(page);
    if (!submit) {
      return {
        status: 'failed',
        note: 'no submit button found',
        screenshot: await snapshot(page, siteDomain, 'no-submit'),
      };
    }

    await submit.click({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);

    // A challenge *after* submitting is common on bookmarking sites.
    const postChallenge = await detectChallenge(page);
    if (postChallenge) {
      const outcome = await requestAssist({
        domain: siteDomain,
        page,
        need: `Clear the ${postChallenge} to finish the submission on ${siteDomain}.`,
        resolved: async () => !(await detectChallenge(page)),
      });
      if (outcome !== 'resolved') return { status: 'needs_assist', note: `post-submit ${postChallenge}` };
      await page.waitForTimeout(1_500);
    }

    const after = page.url();
    const shown = await readPublishedUrl(page, [
      'input[readonly][value^="http"]',
      'a[href*="/story/"]',
      'a[href*="/p/"]',
      '.permalink a',
      '[class*="success"] a',
    ]);

    const liveUrl = shown ?? (after !== before ? after : undefined);
    if (!liveUrl) {
      return {
        status: 'needs_assist',
        note: 'submitted, but no published URL could be read — check the page',
        screenshot: await snapshot(page, siteDomain, 'no-url'),
      };
    }

    // Best-effort confirmation. The real verification pass is Phase 4.
    const hasLink = await pageContainsLink(page, ctx.payload.url);
    return {
      status: 'submitted',
      liveUrl,
      note: hasLink ? 'link visible on the page' : 'link not visible yet — may be pending moderation',
      screenshot: await snapshot(page, siteDomain, 'submitted'),
    };
  },
};
