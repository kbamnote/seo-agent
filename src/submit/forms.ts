/**
 * The generic form filler — what handles every platform without a hand-written
 * recipe, which is most of the long tail.
 *
 * Order of operations is deliberate: a keyword heuristic first, the LLM only for
 * what the heuristic could not place. The heuristic is free, instant and
 * deterministic, and it correctly handles the nine field names that 90% of
 * submission forms actually use. Asking a model to re-derive "the input called
 * `story_title` is the title" on every page would be slower, costlier and less
 * reliable.
 *
 * Two hard refusals are built in, and they are not configurable:
 *   - It will not type into a payment or government-ID field.
 *   - It will not click a button that looks like it spends money.
 * A submission form that asks for a card number is not a submission form.
 */

import type { Locator, Page } from 'playwright';
import { chatJson } from '../llm/index.ts';
import { env } from '../config.ts';
import { log } from '../util/log.ts';

export type FieldSlot =
  | 'title'
  | 'url'
  | 'body'
  | 'tags'
  | 'category'
  | 'name'
  | 'email'
  | 'username'
  | 'password'
  | 'phone'
  | 'city'
  | 'file'
  | 'ignore';

export interface SubmissionPayload {
  title: string;
  body: string;
  url: string;
  anchorText: string;
  tags?: string[];
  category?: string;
  name?: string;
  email?: string;
  username?: string;
  password?: string;
  phone?: string;
  city?: string;
  assetPath?: string;
}

interface FieldInfo {
  index: number;
  locator: Locator;
  tag: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  required: boolean;
  maxLength: number | null;
}

/** Never typed into, whatever the page says. */
const REFUSE_FIELD =
  /\b(card[_-]?number|cardnumber|cc[_-]?num|cvv|cvc|security[_-]?code|expir|iban|routing|account[_-]?number|ssn|social[_-]?security|aadhaar|aadhar|pan[_-]?card|passport)\b/i;

/** Never clicked automatically. */
const REFUSE_BUTTON = /\b(pay|payment|buy|purchase|checkout|subscribe|upgrade|donate|billing)\b/i;

const SLOT_PATTERNS: Array<[FieldSlot, RegExp, number]> = [
  ['url', /\b(url|link|website|site[_-]?url|page[_-]?url|address|permalink|href)\b/i, 10],
  ['title', /\b(title|headline|subject|story[_-]?title|post[_-]?title|name[_-]?of[_-]?(story|post))\b/i, 10],
  ['body', /\b(body|description|content|text|message|summary|excerpt|about|bio|details|story|abstract)\b/i, 8],
  ['tags', /\b(tags?|keywords?|labels?|topics?)\b/i, 9],
  ['category', /\b(category|categories|section|channel|group|industry)\b/i, 9],
  ['email', /\b(e-?mail)\b/i, 10],
  ['password', /\b(password|passwd|pwd)\b/i, 10],
  ['username', /\b(user[_-]?name|login|handle|nick|screen[_-]?name)\b/i, 9],
  ['name', /\b(full[_-]?name|your[_-]?name|business[_-]?name|company|first[_-]?name|contact[_-]?name)\b/i, 7],
  ['phone', /\b(phone|mobile|tel|contact[_-]?number|whatsapp)\b/i, 9],
  ['city', /\b(city|town|location|place|area)\b/i, 8],
];

/**
 * Passed to Playwright as a **string**, not a function.
 *
 * tsx compiles with esbuild's `keepNames`, which wraps every function in a
 * `__name(...)` helper. That helper exists in Node, not in the page, so a
 * function handed to `evaluate` arrives in the browser referencing something
 * undefined and dies with "__name is not defined". A string is sent verbatim
 * and has no such problem. Any future `evaluate` in this project should be
 * written the same way.
 */
const TAG_ATTR = 'data-seoagent-field';

/**
 * One page-side pass that tags every candidate field with `data-seoagent-field`
 * and returns the descriptors. Each field is then addressed by that attribute.
 *
 * Two reasons it is written this way, both learned the hard way:
 *
 *   1. It is a **string**, not a function. tsx compiles with esbuild's
 *      `keepNames`, which wraps functions in a `__name()` helper that exists in
 *      Node and not in the page — a function handed to `evaluate` arrives in the
 *      browser referencing something undefined. Any `evaluate` in this project
 *      should be a string.
 *   2. `locator.evaluate` with a string **returns the function instead of
 *      calling it**, because a string is an expression, not a callback. So the
 *      element cannot be passed that way at all; tagging and returning
 *      everything in one call sidesteps it, and costs one round trip instead of
 *      sixty.
 */
const TAG_AND_DESCRIBE = `(() => {
  const ATTR = '${TAG_ATTR}';
  document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));

  const nodes = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
  const out = [];

  nodes.slice(0, 80).forEach((input) => {
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(type) !== -1) return;
    if (input.disabled) return;
    // offsetParent is null for display:none and for anything in a hidden tree.
    const visible = !!(input.offsetParent || input.getClientRects().length);
    if (!visible) return;

    let label = '';
    const id = input.getAttribute('id');
    if (id) {
      try {
        const esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
        const forLabel = document.querySelector('label[for="' + esc + '"]');
        if (forLabel) label = forLabel.textContent || '';
      } catch (e) { /* malformed id */ }
    }
    if (!label && input.closest) {
      const parent = input.closest('label');
      if (parent) label = parent.textContent || '';
    }
    if (!label) {
      const prev = input.previousElementSibling;
      if (prev && /label|span|div|p/i.test(prev.tagName)) label = prev.textContent || '';
    }

    const index = out.length;
    input.setAttribute(ATTR, String(index));
    const maxLength = input.getAttribute('maxlength');

    out.push({
      index: index,
      tag: input.tagName.toLowerCase(),
      type: type,
      name: input.getAttribute('name') || '',
      id: id || '',
      placeholder: input.getAttribute('placeholder') || '',
      ariaLabel: input.getAttribute('aria-label') || '',
      label: (label || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      required: input.hasAttribute('required') || input.getAttribute('aria-required') === 'true',
      maxLength: maxLength ? Number(maxLength) : null
    });
  });

  return out;
})()`;

async function describeFields(page: Page): Promise<FieldInfo[]> {
  let described: Array<Omit<FieldInfo, 'locator'>>;
  try {
    described = (await page.evaluate(TAG_AND_DESCRIBE)) as Array<Omit<FieldInfo, 'locator'>>;
  } catch (err) {
    log.warn(`could not read the form: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  return described.map((info) => ({
    ...info,
    locator: page.locator(`[${TAG_ATTR}="${info.index}"]`).first(),
  }));
}

function haystack(f: FieldInfo): string {
  return `${f.name} ${f.id} ${f.placeholder} ${f.ariaLabel} ${f.label}`;
}

/** Keyword classification. Returns null when nothing matches confidently. */
function classify(f: FieldInfo): FieldSlot | null {
  const text = haystack(f);

  if (REFUSE_FIELD.test(text)) return 'ignore';
  if (f.type === 'file') return 'file';
  if (f.type === 'email') return 'email';
  if (f.type === 'password') return 'password';
  if (f.type === 'tel') return 'phone';
  if (f.type === 'url') return 'url';
  if (f.type === 'checkbox' || f.type === 'radio') return 'ignore';

  let best: { slot: FieldSlot; score: number } | null = null;
  for (const [slot, pattern, weight] of SLOT_PATTERNS) {
    if (!pattern.test(text)) continue;
    // A textarea is far more likely to be the body than the title.
    const bonus =
      (slot === 'body' && (f.tag === 'textarea' || f.tag === 'div')) ||
      (slot === 'title' && f.tag === 'input')
        ? 3
        : 0;
    const score = weight + bonus;
    if (!best || score > best.score) best = { slot, score };
  }

  if (best) return best.slot;
  // An unlabelled textarea is the body often enough to be worth guessing.
  if (f.tag === 'textarea') return 'body';
  return null;
}

/** LLM pass for fields the heuristic could not place. */
async function classifyWithLlm(unknown: FieldInfo[]): Promise<Map<number, FieldSlot>> {
  const out = new Map<number, FieldSlot>();
  if (!env.llm.apiKey || !unknown.length) return out;

  try {
    const result = await chatJson<{ fields?: Array<{ index: number; slot: string }> }>(
      [
        {
          role: 'system',
          content:
            'You map form fields to semantic slots for a content submission form.\n' +
            'Return JSON: {"fields":[{"index":0,"slot":"title"}]}\n' +
            'Valid slots: title, url, body, tags, category, name, email, username, password, phone, city, file, ignore.\n' +
            'Use "ignore" for anything you are unsure about, and for anything asking for payment ' +
            'details or government identity numbers. Never guess a slot you are not confident in.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            unknown.map((f) => ({
              index: f.index,
              tag: f.tag,
              type: f.type,
              name: f.name,
              placeholder: f.placeholder,
              label: f.label,
              required: f.required,
            })),
          ),
        },
      ],
      { temperature: 0, maxTokens: 500 },
    );

    for (const entry of result.fields ?? []) {
      const slot = String(entry.slot) as FieldSlot;
      if (slot && slot !== 'ignore') out.set(Number(entry.index), slot);
    }
  } catch (err) {
    log.debug(`LLM field mapping failed: ${err instanceof Error ? err.message : err}`);
  }
  return out;
}

function valueFor(slot: FieldSlot, payload: SubmissionPayload, maxLength: number | null): string | null {
  const clip = (s: string) => (maxLength && maxLength > 0 ? s.slice(0, maxLength) : s);

  switch (slot) {
    case 'title':
      return clip(payload.title);
    case 'url':
      return payload.url;
    case 'body':
      return clip(payload.body);
    case 'tags':
      return payload.tags?.length ? clip(payload.tags.join(', ')) : null;
    case 'category':
      return payload.category ?? null;
    case 'name':
      return payload.name ?? null;
    case 'email':
      return payload.email ?? null;
    case 'username':
      return payload.username ?? null;
    case 'password':
      return payload.password ?? null;
    case 'phone':
      return payload.phone ?? null;
    case 'city':
      return payload.city ?? null;
    default:
      return null;
  }
}

export interface FillReport {
  filled: Array<{ slot: FieldSlot; name: string }>;
  skipped: Array<{ name: string; why: string }>;
  refused: string[];
  missingRequired: string[];
}

export async function fillForm(
  page: Page,
  payload: SubmissionPayload,
  opts: { useLlm?: boolean } = {},
): Promise<FillReport> {
  const fields = await describeFields(page);
  const report: FillReport = { filled: [], skipped: [], refused: [], missingRequired: [] };

  const assigned = new Map<number, FieldSlot>();
  const unknown: FieldInfo[] = [];

  for (const f of fields) {
    if (REFUSE_FIELD.test(haystack(f))) {
      report.refused.push(f.name || f.label || `field ${f.index}`);
      continue;
    }
    const slot = classify(f);
    if (slot) assigned.set(f.index, slot);
    else unknown.push(f);
  }

  if (report.refused.length) {
    throw new Error(
      `This form asks for payment or identity details (${report.refused.join(', ')}). ` +
        'Refusing to fill it. A submission form should never need these.',
    );
  }

  if (opts.useLlm !== false && unknown.length) {
    const mapped = await classifyWithLlm(unknown);
    for (const [index, slot] of mapped) assigned.set(index, slot);
  }

  // One slot can only be filled once: the first (usually topmost) field wins.
  const used = new Set<FieldSlot>();

  for (const f of fields) {
    const slot = assigned.get(f.index);
    if (!slot || slot === 'ignore') {
      report.skipped.push({ name: f.name || f.label || `field ${f.index}`, why: 'unmapped' });
      if (f.required) report.missingRequired.push(f.name || f.label || `field ${f.index}`);
      continue;
    }
    if (used.has(slot) && slot !== 'tags') {
      report.skipped.push({ name: f.name || `field ${f.index}`, why: `${slot} already filled` });
      continue;
    }

    try {
      if (slot === 'file') {
        if (!payload.assetPath) {
          report.skipped.push({ name: f.name, why: 'no file to upload' });
          continue;
        }
        await f.locator.setInputFiles(payload.assetPath);
      } else if (f.tag === 'select') {
        const wanted = valueFor(slot, payload, null);
        if (!wanted) continue;
        await f.locator.selectOption({ label: wanted }).catch(async () => {
          // Fall back to the first real option rather than leaving it empty.
          const options = await f.locator.locator('option').allTextContents();
          const firstReal = options.find((o) => o.trim() && !/^(select|choose|--)/i.test(o.trim()));
          if (firstReal) await f.locator.selectOption({ label: firstReal }).catch(() => undefined);
        });
      } else {
        const value = valueFor(slot, payload, f.maxLength);
        if (value === null) {
          report.skipped.push({ name: f.name, why: `no ${slot} in payload` });
          continue;
        }
        if (f.tag === 'div') await f.locator.fill(value); // contenteditable
        else await f.locator.fill(value);
      }

      used.add(slot);
      report.filled.push({ slot, name: f.name || f.label || `field ${f.index}` });
    } catch (err) {
      report.skipped.push({
        name: f.name || `field ${f.index}`,
        why: err instanceof Error ? err.message.slice(0, 80) : 'fill failed',
      });
    }
  }

  log.debug(`form: filled ${report.filled.map((f) => f.slot).join(', ') || 'nothing'}`);
  return report;
}

/** Finds the submit control, refusing anything that looks like a payment. */
export async function findSubmit(page: Page): Promise<Locator | null> {
  const candidates = [
    'form button[type="submit"]',
    'form input[type="submit"]',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    const text = ((await locator.innerText().catch(() => '')) || (await locator.getAttribute('value')) || '').trim();
    if (REFUSE_BUTTON.test(text)) {
      log.warn(`refusing to click "${text}" — it looks like a payment action`);
      continue;
    }
    if (await locator.isVisible().catch(() => false)) return locator;
  }

  // Text-based fallback for forms with no typed submit button.
  const byText = page
    .locator('button, a[role="button"], input[type="button"]')
    .filter({ hasText: /\b(submit|post|publish|save|add|send|create|share)\b/i })
    .first();

  if ((await byText.count().catch(() => 0)) > 0) {
    const text = (await byText.innerText().catch(() => '')) ?? '';
    if (REFUSE_BUTTON.test(text)) {
      log.warn(`refusing to click "${text.trim()}" — it looks like a payment action`);
      return null;
    }
    if (await byText.isVisible().catch(() => false)) return byText;
  }

  return null;
}
