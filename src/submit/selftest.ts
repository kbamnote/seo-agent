/**
 * Self-test for the submission machinery.
 *
 * Runs the real form filler against a local fixture file: no network, no third
 * party, nothing published. It is the only way to know the filler works without
 * posting to somebody's live site, and it catches the failures that matter —
 * a field mapped to the wrong slot, a maxlength ignored, a select left on its
 * placeholder, the payment refusal not firing.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../db/index.ts';
import { log } from '../util/log.ts';
import { fillForm, findSubmit, type SubmissionPayload } from './forms.ts';

const PAYLOAD: SubmissionPayload = {
  title: 'Choosing a data analysis course in Nagpur',
  body:
    'A short description of what the article covers, long enough to test that the ' +
    'maxlength attribute on the description field is respected by the filler rather ' +
    'than being silently truncated by the browser or rejected by the form.',
  url: 'https://eeetechnologies.in',
  anchorText: 'EEE Technologies',
  tags: ['Data Analysis Course in Nagpur'],
  category: 'Education',
  name: 'EEE Technologies',
  email: 'eeetechnologiesng@gmail.com',
  city: 'Nagpur',
};

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export async function runSelfTest(): Promise<{ checks: Check[]; ok: boolean }> {
  const { chromium } = await import('playwright');
  const checks: Check[] = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // ── 1. An ordinary submission form ────────────────────────────────────────
    const fixture = pathToFileURL(resolve(PROJECT_ROOT, 'test/fixtures/submit-form.html')).toString();
    await page.goto(fixture);

    // useLlm: false keeps the test deterministic and free — the heuristic alone
    // must handle a form this ordinary.
    const report = await fillForm(page, PAYLOAD, { useLlm: false });

    const slots = new Set(report.filled.map((f) => f.slot));
    for (const slot of ['title', 'url', 'body', 'tags', 'category', 'email'] as const) {
      checks.push({
        name: `maps ${slot}`,
        pass: slots.has(slot),
        detail: slots.has(slot) ? 'filled' : `NOT filled (${report.skipped.map((s) => s.name).join(', ')})`,
      });
    }

    // String form, for the same `__name` reason documented in forms.ts.
    const values = (await page.evaluate(`(() => {
      const v = (sel) => { const el = document.querySelector(sel); return el ? el.value : null; };
      return {
        title: v('#story_title'),
        url: v('#page_url'),
        description: v('#descr'),
        tags: v('#tags'),
        category: v('#cat'),
        email: v('#email'),
        name: v('#submitter')
      };
    })()`)) as Record<string, string | null>;

    checks.push({
      name: 'title value correct',
      pass: values.title === PAYLOAD.title,
      detail: String(values.title),
    });
    checks.push({
      name: 'url value correct',
      pass: values.url === PAYLOAD.url,
      detail: String(values.url),
    });
    checks.push({
      name: 'description respects maxlength=400',
      pass: (values.description?.length ?? 0) > 0 && (values.description?.length ?? 0) <= 400,
      detail: `${values.description?.length ?? 0} chars`,
    });
    checks.push({
      name: 'select left off its placeholder',
      pass: Boolean(values.category) && values.category !== '',
      detail: String(values.category),
    });
    checks.push({
      name: 'name field filled',
      pass: values.name === PAYLOAD.name,
      detail: String(values.name),
    });

    const submit = await findSubmit(page);
    const submitText = submit ? ((await submit.innerText()) ?? '').trim() : null;
    checks.push({
      name: 'finds the submit button',
      pass: submitText === 'Publish story',
      detail: String(submitText),
    });

    // ── 2. A form asking for payment details must be refused ──────────────────
    const payDir = resolve(PROJECT_ROOT, 'data/reports');
    mkdirSync(payDir, { recursive: true });
    const payFixture = resolve(payDir, '.selftest-payment-form.html');
    writeFileSync(
      payFixture,
      `<!doctype html><html><body><form>
         <label for="t">Listing title</label><input id="t" name="title">
         <label for="cc">Card number</label><input id="cc" name="card_number">
         <label for="cvv">CVV</label><input id="cvv" name="cvv">
         <button type="submit">Pay and publish</button>
       </form></body></html>`,
      'utf8',
    );

    await page.goto(pathToFileURL(payFixture).toString());
    let refused = false;
    let refusalMessage = '';
    try {
      await fillForm(page, PAYLOAD, { useLlm: false });
    } catch (err) {
      refused = true;
      refusalMessage = err instanceof Error ? err.message : String(err);
    }
    checks.push({
      name: 'refuses a form asking for card details',
      pass: refused,
      detail: refused ? refusalMessage.slice(0, 90) : 'IT FILLED THE FORM — this is a defect',
    });

    const payButton = await findSubmit(page);
    checks.push({
      name: 'refuses to click "Pay and publish"',
      pass: payButton === null,
      detail: payButton ? 'returned a locator — this is a defect' : 'returned null',
    });
  } finally {
    await browser.close();
  }

  const ok = checks.every((c) => c.pass);
  return { checks, ok };
}

export function printSelfTest(result: { checks: Check[]; ok: boolean }) {
  log.heading('Submission self-test');
  for (const c of result.checks) {
    console.log(`  ${c.pass ? 'pass' : 'FAIL'}  ${c.name.padEnd(42)} ${c.detail.slice(0, 60)}`);
  }
  console.log(
    `\n  ${result.checks.filter((c) => c.pass).length}/${result.checks.length} passed` +
      (result.ok ? '' : ' — see the failures above') +
      '\n',
  );
}
