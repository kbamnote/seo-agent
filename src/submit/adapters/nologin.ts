/**
 * Adapters for the publish-without-an-account platforms: JustPaste.it and
 * Write.as.
 *
 * These two are worth hand-writing precisely because they need no login, no
 * email verification and no CAPTCHA in the normal path. That makes them the
 * only browser adapters that can run completely unattended from the first
 * submission — everything else needs a human once.
 *
 * Both are marked `untested`: the selector candidates come from the platforms'
 * structure, and the first run of each should be watched with
 * `HEADLESS=false` so a wrong guess is visible rather than silent. That is an
 * honest label, not a disclaimer — a selector written without seeing the live
 * DOM is a hypothesis.
 */

import { snapshot } from '../browser.ts';
import { clickFirst, fillFirst, pageContainsLink, readPublishedUrl } from './helpers.ts';
import { detectChallenge, requestAssist } from '../assist.ts';
import type { SiteAdapter, SubmitContext, SubmitOutcome } from './types.ts';

/**
 * JustPaste.it — the editor is a rich-text area; publishing redirects to the
 * new paste's short URL, which is how success is detected.
 */
export const justpasteAdapter: SiteAdapter = {
  id: 'justpaste',
  categories: ['bookmarking', 'blog'],
  requiresAccount: false,
  confidence: 'confirmed',

  async submit(ctx: SubmitContext): Promise<SubmitOutcome> {
    const { page, siteDomain } = ctx;

    await page.goto('https://justpaste.it/', { waitUntil: 'domcontentloaded' }).catch(() => null);

    // TinyMCE boots after DOM ready; without this the editor simply is not there.
    await page.waitForSelector('#tinyMCEEditor', { state: 'attached', timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(1_500);

    const titled = await fillFirst(
      page,
      ['input[placeholder="Title"]', 'input[placeholder*="itle"]'],
      ctx.payload.title,
      'title',
    );

    /**
     * Switch to the HTML tab before writing the body.
     *
     * The visible editor is a TinyMCE iframe and its backing textarea is hidden,
     * which is why the first version reported "could not find the editor". The
     * HTML tab reveals that textarea, and writing raw HTML is the only way to
     * guarantee a real <a href>. Typed plain text gives a bare URL, and this
     * project's own verifier counts that as a mention, not a link.
     */
    const htmlTab = await clickFirst(
      page,
      ['a.editorTabRight:has-text("HTML")', 'a:has-text("HTML")', 'button:has-text("HTML")'],
      'HTML tab',
    );
    if (!htmlTab) {
      return {
        status: 'failed',
        note: 'could not switch to the HTML tab',
        screenshot: await snapshot(page, siteDomain, 'no-html-tab'),
      };
    }
    await page.waitForTimeout(800);

    const paragraphs = ctx.payload.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/</g, '&lt;')}</p>`)
      .join('');

    const html = `${paragraphs}<p><a href="${ctx.payload.url}">${ctx.payload.anchorText}</a></p>`;

    const bodied = await fillFirst(page, ['#tinyMCEEditor', 'textarea.mainTextarea'], html, 'body');
    if (!bodied) {
      return {
        status: 'failed',
        note: 'HTML tab opened but the textarea did not accept the body',
        screenshot: await snapshot(page, siteDomain, 'no-editor'),
      };
    }

    /**
     * Switch back to EDITOR before publishing.
     *
     * Writing into the HTML textarea does not reach TinyMCE's model - its value
     * is set, but the editor never reads it, so Publish fires on an empty
     * document and the page simply stays put. Clicking the EDITOR tab is what
     * syncs the source into the editor; verified in the live DOM, where the
     * iframe body only gained the content after that click.
     */
    await clickFirst(page, ['a.editorTabRight:has-text("EDITOR")', 'a:has-text("EDITOR")'], 'editor tab');
    await page.waitForTimeout(1_200);

    const before = page.url();
    const clicked = await clickFirst(
      page,
      ['button.publishButton', 'button:has-text("Publish")', '#publishBtn'],
      'publish',
    );
    if (!clicked) {
      return {
        status: 'failed',
        note: 'no publish control found',
        screenshot: await snapshot(page, siteDomain, 'no-publish'),
      };
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 25_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);

    const challenge = await detectChallenge(page);
    if (challenge) {
      const outcome = await requestAssist({
        domain: siteDomain,
        page,
        need: `Clear the ${challenge} to finish publishing on justpaste.it.`,
        resolved: async () => !(await detectChallenge(page)),
      });
      if (outcome !== 'resolved') return { status: 'needs_assist', note: challenge };
      await page.waitForTimeout(2_000);
    }

    const after = page.url();
    const shown = await readPublishedUrl(page, [
      'input[readonly][value*="justpaste.it"]',
      'a[href*="justpaste.it/"]',
    ]);
    /**
     * Publishing bounced to https://justpaste.it/1_year_for_1_month - an upsell
     * page - and the adapter called that a live backlink. The verifier caught it,
     * but an adapter must not hand the verifier a result it has already been
     * told is wrong.
     *
     * Two guards: the URL has to look like a paste rather than a marketing page,
     * and the client link has to actually be on it.
     */
    const MARKETING =
      /^\/(|premium|account|terms|privacy|cookies|blog|about|login|register|\d+_year[a-z_]*)$/i;

    const looksLikePaste = (url: string): boolean => {
      try {
        const u = new URL(url);
        if (!/justpaste\.it$/i.test(u.hostname.replace(/^www\./, ""))) return false;
        const path = u.pathname.replace(/\/+$/, "");
        if (!path) return false; // the bare root is the editor
        return !MARKETING.test(path);
      } catch {
        return false;
      }
    };

    const liveUrl = [after, shown].find((u) => u && looksLikePaste(u));

    if (!liveUrl) {
      return {
        status: "failed",
        note: `publish did not land on a paste page (ended at ${after})`,
        screenshot: await snapshot(page, siteDomain, "not-a-paste"),
      };
    }

    const hasLink = await pageContainsLink(page, ctx.payload.url);
    if (!hasLink) {
      return {
        status: "failed",
        liveUrl,
        note: `published to ${liveUrl} but the client link is not on the page`,
        screenshot: await snapshot(page, siteDomain, "no-link"),
      };
    }

    return {
      status: "submitted",
      liveUrl,
      note: (titled ? "" : "title field not found; published untitled. ") + "link visible on the page",
      screenshot: await snapshot(page, siteDomain, "submitted"),
    };
  },
};

/**
 * Write.as — anonymous posting. One textarea where the first line becomes the
 * title, then Publish.
 */
export const writeasAdapter: SiteAdapter = {
  id: 'writeas',
  categories: ['blog'],
  requiresAccount: false,
  confidence: 'untested',

  async submit(ctx: SubmitContext): Promise<SubmitOutcome> {
    const { page, siteDomain } = ctx;

    await page.goto('https://write.as/new', { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForTimeout(1_200);

    // Write.as takes the first line as the title, so they are sent together.
    const content = `# ${ctx.payload.title}\n\n${ctx.payload.body}\n\n[${ctx.payload.anchorText}](${ctx.payload.url})`;

    const bodied = await fillFirst(
      page,
      ['#writer', 'textarea#writer', 'textarea', 'div[contenteditable="true"]'],
      content,
      'body',
    );
    if (!bodied) {
      return {
        status: 'failed',
        note: 'could not find the editor',
        screenshot: await snapshot(page, siteDomain, 'no-editor'),
      };
    }

    const before = page.url();
    const clicked = await clickFirst(
      page,
      ['#publish', 'button:has-text("Publish")', 'a:has-text("Publish")', 'button[type="submit"]'],
      'publish',
    );
    if (!clicked) {
      return {
        status: 'failed',
        note: 'no publish control found',
        screenshot: await snapshot(page, siteDomain, 'no-publish'),
      };
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 25_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);

    const after = page.url();
    if (after === before) {
      return {
        status: 'needs_assist',
        note: 'publish did not navigate — check the window',
        screenshot: await snapshot(page, siteDomain, 'no-nav'),
      };
    }

    const hasLink = await pageContainsLink(page, ctx.payload.url);
    return {
      status: 'submitted',
      liveUrl: after,
      note: hasLink ? 'link visible on the page' : 'link not visible — check the published page',
      screenshot: await snapshot(page, siteDomain, 'submitted'),
    };
  },
};
