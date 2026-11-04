/**
 * Shared adapter primitives.
 *
 * Every adapter is written against selector *candidates* rather than one
 * selector, because platforms redesign and a single brittle string is how
 * scrapers rot. The first candidate that is actually visible wins, and if none
 * is, the adapter says so instead of throwing a stack trace.
 */

import type { Locator, Page } from 'playwright';
import { log } from '../../util/log.ts';

export async function firstVisible(page: Page, candidates: string[]): Promise<Locator | null> {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

export async function fillFirst(
  page: Page,
  candidates: string[],
  value: string,
  what: string,
): Promise<boolean> {
  const locator = await firstVisible(page, candidates);
  if (!locator) {
    log.debug(`no field found for ${what}`);
    return false;
  }
  try {
    await locator.click({ timeout: 5_000 }).catch(() => undefined);
    await locator.fill(value);
    return true;
  } catch (err) {
    log.debug(`could not fill ${what}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function clickFirst(page: Page, candidates: string[], what: string): Promise<boolean> {
  const locator = await firstVisible(page, candidates);
  if (!locator) {
    log.debug(`no control found for ${what}`);
    return false;
  }
  try {
    await locator.click({ timeout: 10_000 });
    return true;
  } catch (err) {
    log.debug(`could not click ${what}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/** Waits for the URL to change away from `from`, which is how most publishes signal success. */
export async function waitForNavigationAway(page: Page, from: string, timeoutMs = 20_000): Promise<boolean> {
  try {
    await page.waitForFunction((previous) => window.location.href !== previous, from, {
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

/** Reads a published URL out of the page, for platforms that show it rather than navigating. */
export async function readPublishedUrl(page: Page, candidates: string[]): Promise<string | null> {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    const value =
      (await locator.getAttribute('value').catch(() => null)) ??
      (await locator.getAttribute('href').catch(() => null)) ??
      (await locator.innerText().catch(() => null));
    if (value && /^https?:\/\//.test(value.trim())) return value.trim();
  }
  return null;
}

/** Does the page contain the client's link? The only honest proof of success. */
export async function pageContainsLink(page: Page, targetUrl: string): Promise<boolean> {
  const host = targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const html = await page.content().catch(() => '');
  return html.includes(host);
}
