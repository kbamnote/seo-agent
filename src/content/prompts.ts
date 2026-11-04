/**
 * Prompt construction.
 *
 * Kept separate from the writer so the rules are readable as rules. Two of them
 * matter more than the rest:
 *
 *   1. **The model may not invent specifics about the client.** Fees, placement
 *      percentages, student counts, ratings, testimonials — inventing any of
 *      those puts a false claim on the public internet under the client's name.
 *      The only permitted specifics are the ones in the client config's `facts`.
 *   2. **Every piece has to be worth reading on its own.** Content written only
 *      to carry a link is thin content, which is the thing Google has spent a
 *      decade getting good at ignoring. The takeaway requirement is there to
 *      force something useful into every asset.
 */

import type { ClientConfig } from '../config.ts';
import type { ClientContentRules, GenerateRequest } from './types.ts';

export function rulesOf(cfg: ClientConfig): ClientContentRules {
  return ((cfg as unknown as { content?: ClientContentRules }).content ?? {}) as ClientContentRules;
}

function constraints(cfg: ClientConfig): string {
  const rules = rulesOf(cfg);
  const lines: string[] = [];

  lines.push(`Business: ${cfg.name} — ${cfg.niche ?? 'unspecified'}${cfg.city ? `, based in ${cfg.city}` : ''}.`);
  lines.push(`Website: ${cfg.siteUrl}`);
  if (rules.audience) lines.push(`Audience: ${rules.audience}`);
  if (rules.tone) lines.push(`Tone: ${rules.tone}`);

  lines.push('');
  lines.push('VERIFIED FACTS — the only specifics you may state about this business:');
  if (rules.facts?.length) for (const f of rules.facts) lines.push(`  - ${f}`);
  else
    lines.push(
      '  (none supplied) — so say nothing specific about this business at all. Write about the ' +
        'subject itself and refer to the business only in general terms.',
    );

  lines.push('');
  lines.push('NEVER state, imply or invent:');
  for (const f of rules.forbidden ?? []) lines.push(`  - ${f}`);
  lines.push('  - anything else not in the verified facts above');

  lines.push('');
  lines.push('STYLE:');
  lines.push('  - Plain English. No "in today\'s fast-paced world", no "unlock your potential".');
  lines.push('  - No em dashes. Short sentences. Specific over enthusiastic.');
  lines.push('  - Do not repeat the keyword mechanically. Write it the way a person would.');
  lines.push('  - British or Indian English spelling is fine; be consistent.');
  for (const m of rulesOf(cfg).mustInclude ?? []) lines.push(`  - ${m}`);

  return lines.join('\n');
}

export const ARTICLE_SYSTEM = `You write genuinely useful articles for small-business websites and publishing platforms.

Return JSON only, in exactly this shape:
{
  "title": "60 characters or fewer, no colon-subtitle padding",
  "metaDescription": "150-160 characters",
  "sections": [{"heading": "...", "paragraphs": ["...", "..."]}],
  "faq": [{"q": "...", "a": "..."}],
  "takeaway": "one sentence a reader can act on without buying anything"
}

Rules:
- 4 to 6 sections. Each section: a heading someone would actually search, and 2-3 paragraphs.
- 700-1100 words total across all paragraphs.
- 3 to 5 FAQ entries, each answer 2-3 sentences, answering what people really ask.
- The article must stand up if the link in it were removed. If a section exists only to set up a link, delete it.
- Do not mention SEO, backlinks, keywords or ranking.
- Do not write a conclusion that repeats the introduction.`;

export function articleUser(cfg: ClientConfig, req: GenerateRequest, avoidTitles: string[]): string {
  const parts = [
    constraints(cfg),
    '',
    `TOPIC: ${req.keyword}`,
    `The article will be published on: ${req.siteDomain ?? 'a third-party publishing platform'}`,
    '',
    'One link to the business will be inserted separately. Do not add links yourself, and do not ' +
      'write "click here" or "visit our website" anywhere.',
  ];

  if (avoidTitles.length) {
    parts.push(
      '',
      'Articles already written for this topic. Pick a genuinely different angle, not a reworded one:',
      ...avoidTitles.map((t) => `  - ${t}`),
    );
  }
  return parts.join('\n');
}

export const SHORT_SYSTEM = `You write short promotional copy that does not read as promotional copy.

Return JSON only:
{"title": "...", "body": "..."}

Rules:
- Say what the thing is and who it helps. No adjectives doing the work of facts.
- No "leading", "premier", "best-in-class", "one-stop", "cutting-edge".
- No exclamation marks. No emoji unless asked.
- Do not include a URL in the body; the link is added separately.`;

interface ShortSpec {
  what: string;
  length: string;
}

const SHORT_SPECS: Record<string, ShortSpec> = {
  bookmarking: {
    what: 'a bookmark submission: a title and a two or three sentence description of a page',
    length: 'body: 35-60 words',
  },
  profile: {
    what: 'a profile bio for a business account on a third-party platform',
    length: 'body: 40-70 words, written in the third person',
  },
  directory: {
    what: 'a business directory listing description',
    length: 'body: 40-80 words, factual, mentions the city and what is offered',
  },
  image: {
    what: 'an image caption and alt-text-quality description for an infographic',
    length: 'body: 25-45 words describing what the image actually shows',
  },
  pdf: {
    what: 'the description field for a published PDF document',
    length: 'body: 40-70 words saying what is inside the document',
  },
  ppt: {
    what: 'the description field for a published slide deck',
    length: 'body: 40-70 words saying what the deck covers',
  },
  mindmap: {
    what: 'the description for a public mind map',
    length: 'body: 25-50 words saying how the map is organised',
  },
  blog: {
    what: 'a short standfirst for an article',
    length: 'body: 30-50 words',
  },
  ping: {
    what: 'a one-line summary of a published URL',
    length: 'body: 15-30 words',
  },
};

export function shortUser(cfg: ClientConfig, req: GenerateRequest, avoidTitles: string[]): string {
  const spec = SHORT_SPECS[req.type] ?? SHORT_SPECS.bookmarking!;
  const parts = [
    constraints(cfg),
    '',
    `WRITE: ${spec.what}`,
    spec.length,
    `SUBJECT: ${req.keyword}`,
    `PLATFORM: ${req.siteDomain ?? 'a third-party platform'}`,
  ];
  if (avoidTitles.length) {
    parts.push('', 'Titles already used for this subject. Do not reuse or reword them:', ...avoidTitles.map((t) => `  - ${t}`));
  }
  return parts.join('\n');
}

export const OUTLINE_SYSTEM = `You turn a topic into a slide-deck outline.

Return JSON only:
{"title": "...", "slides": [{"heading": "...", "bullets": ["...", "...", "..."]}]}

Rules:
- 6 to 8 slides, each with 3-4 bullets of at most 12 words.
- One idea per bullet. No bullet that is just a restatement of the heading.
- The last slide summarises what the reader should do next, without selling.`;

export function outlineUser(cfg: ClientConfig, req: GenerateRequest): string {
  return [constraints(cfg), '', `TOPIC: ${req.keyword}`].join('\n');
}

export const MINDMAP_SYSTEM = `You turn a topic into a mind map.

Return JSON only:
{"title": "...", "branches": [{"label": "...", "children": ["...", "..."]}]}

Rules:
- 4 to 6 branches, each with 3-5 children.
- Labels are 2-5 words. No sentences.
- Cover the topic as a learner would need to see it, in a sensible order.`;

export function mindmapUser(cfg: ClientConfig, req: GenerateRequest): string {
  return [constraints(cfg), '', `TOPIC: ${req.keyword}`].join('\n');
}
