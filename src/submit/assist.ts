/**
 * Assist Mode.
 *
 * The agent does not solve CAPTCHAs and does not read OTPs out of a mailbox it
 * was not given. When it hits one, it stops, shows the human the window it is
 * already looking at, tells them what is needed, and waits.
 *
 * The important property is that this is **once per site, not once per link**:
 * the browser profile persists, so after a human clears the challenge the
 * session cookie carries every later submission to that platform. That is what
 * makes the whole arrangement cheaper than doing the work by hand, rather than
 * more expensive.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { SESSIONS_DIR, env } from '../config.ts';
import { log } from '../util/log.ts';
import { snapshot } from './browser.ts';

export type AssistOutcome = 'resolved' | 'timeout' | 'no_operator';

const CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '#challenge-form',
];

const OTP_HINTS =
  /\b(one[- ]time (code|password)|verification code|otp|enter the code|check your (email|inbox|phone))\b/i;

export interface AssistRequest {
  domain: string;
  page: Page;
  /** What the human has to do, in one line. */
  need: string;
  /** Polled until true — that is how the agent knows it can carry on. */
  resolved: () => Promise<boolean>;
  timeoutMs?: number;
}

/** Anything on the page that a human has to deal with. */
export async function detectChallenge(page: Page): Promise<string | null> {
  for (const selector of CHALLENGE_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return `captcha (${selector})`;
  }

  const text = await page
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch(() => '');
  if (OTP_HINTS.test(text)) return 'otp or email verification';

  return null;
}

/**
 * Sends the operator a WhatsApp through the existing Tapify sender, if one is
 * configured. Failure to notify is never fatal — the console message is the
 * fallback and the agent is already waiting.
 */
async function notifyOperator(message: string): Promise<void> {
  const endpoint = process.env.TAPIFY_WA_ENDPOINT?.trim();
  const to = process.env.OPERATOR_WHATSAPP?.trim();
  if (!endpoint || !to) return;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.debug(`operator notify returned ${res.status}`);
  } catch (err) {
    log.debug(`operator notify failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Same path rule as browser.ts, so both agree on where a profile lives. */
function profileDirFor(domain: string): string {
  return resolve(SESSIONS_DIR, domain.replace(/[^a-z0-9.-]/gi, '_'));
}

function continueFile(domain: string): string {
  return resolve(profileDirFor(domain), 'CONTINUE');
}

export async function requestAssist(req: AssistRequest): Promise<AssistOutcome> {
  /**
   * Nobody is there to help on a headless host.
   *
   * Assist Mode exists so a person can clear a CAPTCHA in a window they can
   * see. Running headless — on Railway, or in a scheduled job — there is no
   * window and no person, so waiting ten minutes achieves nothing except
   * burning ten minutes of a cron run, once per stuck platform. Give up at
   * once and say why, so the submission is recorded as needing a human rather
   * than silently timing out.
   */
  if (env.headless) {
    const challenge = await detectChallenge(req.page).catch(() => null);
    log.warn(
      `${req.domain} needs a person (${challenge ?? 'sign-in'}) and this host has no screen. ` +
        'Skipping. Run this platform from a machine where you can see the browser, ' +
        'or move it to the manual queue.',
    );
    await notifyOperator(
      `SEO agent could not finish on ${req.domain}: ${req.need} No screen on this host.`,
    );
    return 'no_operator';
  }

  const timeoutMs = req.timeoutMs ?? 10 * 60_000;
  const shot = await snapshot(req.page, req.domain, 'assist');
  const sentinel = continueFile(req.domain);
  if (existsSync(sentinel)) unlinkSync(sentinel);

  const minutes = Math.round(timeoutMs / 60_000);

  log.heading(`Assist needed — ${req.domain}`);
  console.log(`  ${req.need}`);
  console.log(`  The browser window is open and waiting. Finish the step there.`);
  console.log(`  Current URL: ${req.page.url()}`);
  if (shot) console.log(`  Screenshot:  ${shot}`);
  console.log(`  If the agent does not notice you are done, create this file:`);
  console.log(`    ${sentinel}`);
  console.log(`  Giving up in ${minutes} minute${minutes === 1 ? '' : 's'}.\n`);

  await notifyOperator(
    `SEO agent needs you on ${req.domain}: ${req.need}. The browser window is open on the PC.`,
  );

  const started = Date.now();
  let lastTick = 0;

  while (Date.now() - started < timeoutMs) {
    if (await req.resolved().catch(() => false)) {
      log.info(`assist resolved for ${req.domain} after ${Math.round((Date.now() - started) / 1000)}s`);
      return 'resolved';
    }
    if (existsSync(sentinel)) {
      unlinkSync(sentinel);
      log.info(`continue file seen for ${req.domain}`);
      return 'resolved';
    }

    // A quiet progress line once a minute, so a long wait does not look hung.
    const elapsed = Math.floor((Date.now() - started) / 60_000);
    if (elapsed > lastTick) {
      lastTick = elapsed;
      log.info(`still waiting on ${req.domain} (${elapsed}/${minutes} min)`);
    }

    await new Promise((r) => setTimeout(r, 2_000));
  }

  log.warn(`assist timed out for ${req.domain} — moving on, nothing was submitted`);
  return 'timeout';
}

/** Writes the sentinel, so a human can unblock from another terminal. */
export function writeContinue(domain: string): string {
  const profileDir = resolve('data/sessions', domain.replace(/[^a-z0-9.-]/gi, '_'));
  const path = continueFile(profileDir);
  writeFileSync(path, `${new Date().toISOString()}\n`, 'utf8');
  return path;
}
