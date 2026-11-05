/**
 * Rendering a draft into the forms platforms actually accept, and placing the
 * one link.
 *
 * Link placement is deliberate: never in the first section, never in the last.
 * A link in the opening paragraph reads as an advert and gets edited out by
 * moderators; a link in the closing line is the classic guest-post footprint.
 * The middle of the body, inside a sentence that was going to exist anyway, is
 * where a real citation sits.
 */

import type { AnchorChoice, ArticleDraft } from './types.ts';

/**
 * Strips the characters language models reach for that no human types.
 *
 * The first real article came back with 27 non-breaking hyphens (U+2011) —
 * "user‑facing", "front‑end", "server‑side". They render almost identically to
 * a plain hyphen, so nobody notices, but they break copy-paste, they break
 * in-page search for "front-end", and they are a recognisable fingerprint of
 * machine-written text on a page meant to look like a person wrote it.
 *
 * Also handled: the invisible spacers (zero-width space, joiner, BOM) that
 * survive a copy out of a chat window and do nothing but sit in the HTML.
 */
export function cleanText(text: string): string {
  return text
    .replace(/[\u2010\u2011]/g, '-') // hyphen, non-breaking hyphen
    .replace(/\u00a0/g, ' ') // non-breaking space
    .replace(/[\u200b-\u200d\ufeff]/g, '') // zero-width space, joiners, BOM
    .replace(/\u2212/g, '-') // minus sign used as a hyphen
    .replace(/[ \t]+\n/g, '\n') // trailing spaces before a line break
    .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Removes bare mentions of the client's domain from body text.
 *
 * The design is one link per asset. The first real publish came back with
 * three: the model had written "eeetechnologies.in" into the prose, and the
 * platform turned every plain-text occurrence into a link of its own. Several
 * links to one domain in a short post is a promotional footprint, which is the
 * opposite of what a citation should look like.
 *
 * The inserted markdown link is added after this runs, so it survives.
 */
export function stripBareDomain(text: string, siteUrl: string): string {
  let host: string;
  try {
    host = new URL(siteUrl).hostname.replace(/^www\./i, '');
  } catch {
    return text;
  }

  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Any bare occurrence: with or without scheme, with or without www, and
  // swallowing a trailing path so "site.in/courses" goes too.
  const bare = new RegExp(`(https?:\\/\\/)?(www\\.)?${escaped}(\\/[^\\s)]*)?`, 'gi');

  return text
    .replace(bare, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function wordsIn(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function articleWordCount(draft: ArticleDraft): number {
  let n = wordsIn(draft.title) + wordsIn(draft.takeaway);
  for (const s of draft.sections) {
    n += wordsIn(s.heading);
    for (const p of s.paragraphs) n += wordsIn(p);
  }
  for (const f of draft.faq) n += wordsIn(f.q) + wordsIn(f.a);
  return n;
}

/**
 * Which section should carry the link.
 *
 * Never the first (reads as an advert, gets moderated out) and never the last
 * (the classic guest-post footprint). Among the rest, prefer the section whose
 * heading is actually about choosing or doing the thing — the first real
 * article put the citation at the end of "A typical workday for a full stack
 * developer", where a sentence about local training is a non-sequitur. The
 * section on learning routes was sitting right next to it.
 */
const CITATION_FRIENDLY =
  /(train|training|cours|learn|study|studi|programme|program|institute|option|choos|pick|where|route|provider|admission)/i;

function linkSectionIndex(headings: string[]): number {
  const count = headings.length;
  if (count <= 1) return 0;
  if (count === 2) return 1;

  const first = 1;
  const last = count - 2; // never the final section
  for (let i = first; i <= last; i++) {
    if (CITATION_FRIENDLY.test(headings[i] ?? '')) return i;
  }
  // Nothing obviously suitable: the middle, biased earlier.
  return Math.max(1, Math.floor((count - 1) / 2));
}

interface Placement {
  sectionIndex: number;
  paragraphIndex: number;
  sentence: string;
}

/**
 * Builds the sentence that carries the link. It names the anchor and says
 * something true about why it is there, without "visit" or "click".
 */
function linkSentence(anchor: AnchorChoice, markdown: boolean): string {
  const link = markdown
    ? `[${anchor.text}](${anchor.targetUrl})`
    : `<a href="${anchor.targetUrl}">${anchor.text}</a>`;

  switch (anchor.kind) {
    case 'branded':
      return `Training of this kind is run locally by ${link}.`;
    case 'naked':
      return `A local provider covering this syllabus is listed at ${link}.`;
    case 'partial':
      return `Anyone comparing options locally can look at ${link}.`;
    case 'exact':
    default:
      return `One local option for ${link} is worth comparing against the criteria above.`;
  }
}

function placeLink(draft: ArticleDraft, anchor: AnchorChoice, markdown: boolean): Placement {
  const sectionIndex = linkSectionIndex(draft.sections.map((s) => s.heading));
  const section = draft.sections[sectionIndex]!;
  const paragraphIndex = Math.max(0, section.paragraphs.length - 1);
  return { sectionIndex, paragraphIndex, sentence: linkSentence(anchor, markdown) };
}

export function articleToMarkdown(draft: ArticleDraft, anchor: AnchorChoice): string {
  const place = placeLink(draft, anchor, true);
  const out: string[] = [`# ${draft.title}`, ''];

  draft.sections.forEach((section, si) => {
    out.push(`## ${section.heading}`, '');
    section.paragraphs.forEach((p, pi) => {
      // Strip bare domain mentions first; the intended link is added after, so
      // it survives and stays the only one.
      const clean = stripBareDomain(p, anchor.targetUrl);
      const withLink =
        si === place.sectionIndex && pi === place.paragraphIndex
          ? `${clean} ${place.sentence}`
          : clean;
      out.push(withLink, '');
    });
  });

  if (draft.faq.length) {
    out.push('## Common questions', '');
    for (const f of draft.faq) out.push(`**${f.q}**`, '', f.a, '');
  }
  if (draft.takeaway) out.push(`**In short:** ${draft.takeaway}`, '');

  return cleanText(out.join('\n')).trim();
}

export function articleToHtml(draft: ArticleDraft, anchor: AnchorChoice): string {
  const place = placeLink(draft, anchor, false);
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const out: string[] = [`<h1>${esc(draft.title)}</h1>`];

  draft.sections.forEach((section, si) => {
    out.push(`<h2>${esc(section.heading)}</h2>`);
    section.paragraphs.forEach((p, pi) => {
      const clean = stripBareDomain(p, anchor.targetUrl);
      const body =
        si === place.sectionIndex && pi === place.paragraphIndex
          ? `${esc(clean)} ${place.sentence}`
          : esc(clean);
      out.push(`<p>${body}</p>`);
    });
  });

  if (draft.faq.length) {
    out.push('<h2>Common questions</h2>');
    for (const f of draft.faq) out.push(`<h3>${esc(f.q)}</h3>`, `<p>${esc(f.a)}</p>`);
  }
  if (draft.takeaway) out.push(`<p><strong>In short:</strong> ${esc(draft.takeaway)}</p>`);

  return cleanText(out.join('\n'));
}

/** Plain text, for platforms with a textarea and no formatting. */
export function articleToText(draft: ArticleDraft, anchor: AnchorChoice): string {
  return articleToMarkdown(draft, anchor)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)');
}
