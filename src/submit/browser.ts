/**
 * Browser sessions.
 *
 * One persistent Chromium profile per site, under data/sessions/<domain>. That
 * directory is the whole point: it holds the cookies, so the human clears a
 * CAPTCHA or an OTP **once per site** and every later submission reuses the
 * logged-in session. Without it, Assist Mode would be needed on every single
 * link and the agent would be slower than doing it by hand.
 *
 * Headful by default, because the locked decision is that this runs on a
 * Windows PC where a person can take over the window when the agent gets stuck.
 *
 * What this deliberately does **not** do: spoof fingerprints, patch
 * navigator.webdriver, rotate proxies or otherwise try to look like a different
 * browser than it is. The agent identifies as a normal Chromium, posts to
 * accounts that belong to the client, and when a platform refuses automation it
 * is handed to a human instead. Sites that say no are respected, not defeated.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { SESSIONS_DIR, env } from '../config.ts';
import { log } from '../util/log.ts';

export interface SessionHandle {
  context: BrowserContext;
  page: Page;
  profileDir: string;
  close(): Promise<void>;
}

const open = new Map<string, SessionHandle>();

function profileDirFor(domain: string): string {
  const dir = resolve(SESSIONS_DIR, domain.replace(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Imported lazily so the rest of the CLI works without Chromium installed. */
async function playwright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'Playwright is not installed. Run:\n  npm install playwright\n  npx playwright install chromium',
    );
  }
}

export async function openSession(domain: string): Promise<SessionHandle> {
  const existing = open.get(domain);
  if (existing) return existing;

  const { chromium } = await playwright();
  const profileDir = profileDirFor(domain);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: env.headless,
    viewport: { width: 1360, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // A persistent context opens with one blank page already.
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  const handle: SessionHandle = {
    context,
    page,
    profileDir,
    async close() {
      open.delete(domain);
      await context.close().catch(() => undefined);
    },
  };

  open.set(domain, handle);
  log.debug(`session open: ${domain} (${env.headless ? 'headless' : 'headful'}) ${profileDir}`);
  return handle;
}

export async function closeAllSessions(): Promise<void> {
  for (const handle of [...open.values()]) await handle.close();
}

/** True when the page looks like it is behind a sign-in wall. */
export async function looksSignedOut(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/(login|signin|sign-in|sign_in|auth|accounts)\b/i.test(url)) return true;

  const signInButton = await page
    .locator('a,button')
    .filter({ hasText: /^(log ?in|sign ?in)$/i })
    .count()
    .catch(() => 0);
  const signOutButton = await page
    .locator('a,button')
    .filter({ hasText: /(log ?out|sign ?out|my account|dashboard)/i })
    .count()
    .catch(() => 0);

  return signInButton > 0 && signOutButton === 0;
}

/** Screenshot into the session folder, for the record and for debugging. */
export async function snapshot(page: Page, domain: string, label: string): Promise<string | null> {
  try {
    const path = resolve(profileDirFor(domain), `${Date.now()}-${label.replace(/\W+/g, '-')}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch {
    return null;
  }
}
