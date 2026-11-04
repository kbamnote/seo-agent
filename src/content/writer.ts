/**
 * Text generation.
 *
 * Primary path is the LLM. The fallback is a structural template, and it exists
 * for one honest reason: so the whole pipeline — assets, storage, approval,
 * submission — can be exercised and debugged without a key, and so a quota
 * outage does not stop the agent mid-run.
 *
 * Template output is **not publishable**. It is marked `generator: 'template'`,
 * it always lands in the approval queue whatever the client's autoSubmit rules
 * say, and the submission engine refuses to send it. Publishing skeleton text
 * on fifty platforms is precisely the thin-content problem this project is
 * supposed to avoid.
 */

import type { ClientConfig } from '../config.ts';
import { env } from '../config.ts';
import { chatJson } from '../llm/index.ts';
import { log } from '../util/log.ts';
import {
  ARTICLE_SYSTEM,
  MINDMAP_SYSTEM,
  OUTLINE_SYSTEM,
  SHORT_SYSTEM,
  articleUser,
  mindmapUser,
  outlineUser,
  shortUser,
} from './prompts.ts';
import { cleanText } from './render.ts';
import type { ArticleDraft, GenerateRequest } from './types.ts';

export interface WriterResult<T> {
  value: T;
  generator: 'llm' | 'template';
  model?: string;
}

export function llmAvailable(): boolean {
  return Boolean(env.llm.apiKey);
}

function warnTemplate(what: string) {
  log.warn(
    `${what}: no LLM_API_KEY, so this is TEMPLATE output. Structure only — not publishable. ` +
      'Set LLM_API_KEY in .env and regenerate.',
  );
}

// ── Articles ─────────────────────────────────────────────────────────────────

export async function writeArticle(
  cfg: ClientConfig,
  req: GenerateRequest,
  avoidTitles: string[],
): Promise<WriterResult<ArticleDraft>> {
  if (!llmAvailable()) {
    warnTemplate('article');
    return { value: templateArticle(cfg, req), generator: 'template' };
  }

  const raw = await chatJson<ArticleDraft>(
    [
      { role: 'system', content: ARTICLE_SYSTEM },
      { role: 'user', content: articleUser(cfg, req, avoidTitles) },
    ],
    { temperature: 0.8, maxTokens: 8000 },
  );

  const draft: ArticleDraft = {
    title: String(raw.title ?? req.keyword).slice(0, 120),
    metaDescription: String(raw.metaDescription ?? '').slice(0, 320),
    sections: Array.isArray(raw.sections)
      ? raw.sections
          .filter((s) => s && s.heading)
          .map((s) => ({
            heading: String(s.heading).slice(0, 160),
            paragraphs: (Array.isArray(s.paragraphs) ? s.paragraphs : []).map((p) => String(p)),
          }))
      : [],
    faq: Array.isArray(raw.faq)
      ? raw.faq.filter((f) => f && f.q).map((f) => ({ q: String(f.q), a: String(f.a ?? '') }))
      : [],
    takeaway: String(raw.takeaway ?? ''),
  };

  if (!draft.sections.length) {
    throw new Error('The model returned an article with no sections. Retry or check LLM_MODEL.');
  }
  return { value: draft, generator: 'llm', model: env.llm.model };
}

// ── Short copy ───────────────────────────────────────────────────────────────

export async function writeShort(
  cfg: ClientConfig,
  req: GenerateRequest,
  avoidTitles: string[],
): Promise<WriterResult<{ title: string; body: string }>> {
  if (!llmAvailable()) {
    warnTemplate(req.type);
    return { value: templateShort(cfg, req), generator: 'template' };
  }

  const raw = await chatJson<{ title?: string; body?: string }>(
    [
      { role: 'system', content: SHORT_SYSTEM },
      { role: 'user', content: shortUser(cfg, req, avoidTitles) },
    ],
    { temperature: 0.85, maxTokens: 500 },
  );

  return {
    value: {
      title: cleanText(String(raw.title ?? req.keyword)).slice(0, 160),
      body: cleanText(String(raw.body ?? '')).trim(),
    },
    generator: 'llm',
    model: env.llm.model,
  };
}

// ── Deck outline ─────────────────────────────────────────────────────────────

export interface DeckOutline {
  title: string;
  slides: Array<{ heading: string; bullets: string[] }>;
}

export async function writeOutline(
  cfg: ClientConfig,
  req: GenerateRequest,
): Promise<WriterResult<DeckOutline>> {
  if (!llmAvailable()) {
    warnTemplate('deck outline');
    return { value: templateOutline(cfg, req), generator: 'template' };
  }

  const raw = await chatJson<DeckOutline>(
    [
      { role: 'system', content: OUTLINE_SYSTEM },
      { role: 'user', content: outlineUser(cfg, req) },
    ],
    { temperature: 0.7, maxTokens: 1500 },
  );

  const slides = (Array.isArray(raw.slides) ? raw.slides : [])
    .filter((s) => s && s.heading)
    .map((s) => ({
      heading: String(s.heading).slice(0, 120),
      bullets: (Array.isArray(s.bullets) ? s.bullets : []).map((b) => String(b).slice(0, 160)),
    }));

  if (!slides.length) throw new Error('The model returned a deck with no slides.');
  return { value: { title: String(raw.title ?? req.keyword), slides }, generator: 'llm', model: env.llm.model };
}

// ── Mind map ─────────────────────────────────────────────────────────────────

export interface MindmapOutline {
  title: string;
  branches: Array<{ label: string; children: string[] }>;
}

export async function writeMindmap(
  cfg: ClientConfig,
  req: GenerateRequest,
): Promise<WriterResult<MindmapOutline>> {
  if (!llmAvailable()) {
    warnTemplate('mind map');
    return { value: templateMindmap(cfg, req), generator: 'template' };
  }

  const raw = await chatJson<MindmapOutline>(
    [
      { role: 'system', content: MINDMAP_SYSTEM },
      { role: 'user', content: mindmapUser(cfg, req) },
    ],
    { temperature: 0.7, maxTokens: 1200 },
  );

  const branches = (Array.isArray(raw.branches) ? raw.branches : [])
    .filter((b) => b && b.label)
    .map((b) => ({
      label: String(b.label).slice(0, 60),
      children: (Array.isArray(b.children) ? b.children : []).map((c) => String(c).slice(0, 60)),
    }));

  if (!branches.length) throw new Error('The model returned a mind map with no branches.');
  return {
    value: { title: String(raw.title ?? req.keyword), branches },
    generator: 'llm',
    model: env.llm.model,
  };
}

// ── Templates (structure only, never publishable) ────────────────────────────

const PLACEHOLDER = '[TEMPLATE — replace with real content before publishing]';

function templateArticle(cfg: ClientConfig, req: GenerateRequest): ArticleDraft {
  const topic = req.keyword;
  return {
    title: `${topic}: what to look at before you enrol`,
    metaDescription: `${PLACEHOLDER} A practical look at ${topic.toLowerCase()}.`,
    sections: [
      {
        heading: `What ${topic} actually covers`,
        paragraphs: [PLACEHOLDER, `Outline the syllabus areas a reader should expect. ${PLACEHOLDER}`],
      },
      {
        heading: 'Who it suits, and who it does not',
        paragraphs: [PLACEHOLDER, PLACEHOLDER],
      },
      {
        heading: 'How to judge a training provider',
        paragraphs: [`Criteria a reader can apply themselves. ${PLACEHOLDER}`, PLACEHOLDER],
      },
      {
        heading: `Learning this in ${cfg.city ?? 'your city'}`,
        paragraphs: [PLACEHOLDER, PLACEHOLDER],
      },
    ],
    faq: [
      { q: `How long does ${topic} take?`, a: PLACEHOLDER },
      { q: 'What background do I need?', a: PLACEHOLDER },
      { q: 'Classroom or online?', a: PLACEHOLDER },
    ],
    takeaway: PLACEHOLDER,
  };
}

function templateShort(cfg: ClientConfig, req: GenerateRequest): { title: string; body: string } {
  return {
    title: `${req.keyword} — ${cfg.name}`,
    body: `${PLACEHOLDER} Describe ${req.keyword.toLowerCase()} for a reader in ${cfg.city ?? 'the area'} in two or three sentences.`,
  };
}

function templateOutline(cfg: ClientConfig, req: GenerateRequest): DeckOutline {
  return {
    title: req.keyword,
    slides: [
      { heading: 'What this covers', bullets: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { heading: 'Who it is for', bullets: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { heading: 'Core skills', bullets: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { heading: 'Tools used', bullets: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { heading: 'How to practise', bullets: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { heading: 'Next step', bullets: [PLACEHOLDER, PLACEHOLDER] },
    ],
  };
}

function templateMindmap(cfg: ClientConfig, req: GenerateRequest): MindmapOutline {
  return {
    title: req.keyword,
    branches: [
      { label: 'Foundations', children: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { label: 'Core skills', children: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { label: 'Tools', children: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
      { label: 'Practice', children: [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER] },
    ],
  };
}
