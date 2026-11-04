/**
 * Editorial judgement, by LLM.
 *
 * Why this exists: the mechanical scorer gave a generic bookmarking farm 90 out
 * of 100 and Substack 60. Everything it measures — https, dofollow outbound
 * links, a visible submit button, a modest link count — the farm does perfectly.
 * What gives the farm away is on the page in plain sight: its submitted stories
 * are bearing exporters, visa consultants and SEO services, all on a site that
 * claims to be about something else. No regex catches incoherence; a language
 * model reads it instantly.
 *
 * One cheap call per candidate, opt-in with `--judge`.
 */

import { chatJson } from '../llm/index.ts';
import { env } from '../config.ts';
import { log } from '../util/log.ts';
import type { PageSignals } from './analyse.ts';

export type Editorial = 'editorial' | 'mixed' | 'farm';

export interface Judgement {
  verdict: Editorial;
  confidence: number;
  why: string;
}

const SYSTEM = `You judge whether a website exercises editorial control over what gets published on it.

You are given a domain, its title and description, and the titles of items users have published there, plus the domains it links out to.

Answer with JSON only:
{"verdict": "editorial" | "mixed" | "farm", "confidence": 0.0-1.0, "why": "one sentence, max 25 words"}

- "farm": published items are unrelated commercial spam across incoherent industries (bearings, visas, escorts, casinos, SEO services, replica goods), or the site exists only to host submitted links. Anyone can post anything.
- "mixed": a real platform with weak moderation, or a legitimate niche directory with some junk.
- "editorial": a genuine publication, community or platform where content is moderated, curated, or tied to real accounts and audiences.

Judge only what the evidence shows. A site with no published items listed is "mixed", not "farm" — absence of evidence is not evidence.`;

export async function judgeSite(domain: string, signals: PageSignals): Promise<Judgement | null> {
  if (!env.llm.apiKey) {
    log.debug('judge skipped: no LLM_API_KEY');
    return null;
  }

  const evidence = {
    domain,
    title: signals.title,
    description: signals.metaDescription,
    publishedItemTitles: signals.contentTitles,
    outboundLinkCount: signals.externalLinks,
    distinctOutboundDomains: signals.externalDomains,
    nofollowRatio: signals.nofollowRatio,
  };

  try {
    const result = await chatJson<Partial<Judgement>>(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(evidence, null, 1) },
      ],
      { temperature: 0, maxTokens: 200 },
    );

    const verdict = result.verdict;
    if (verdict !== 'editorial' && verdict !== 'mixed' && verdict !== 'farm') {
      log.debug(`judge returned an unusable verdict for ${domain}: ${JSON.stringify(result)}`);
      return null;
    }
    return {
      verdict,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0.5)),
      why: String(result.why ?? '').slice(0, 200),
    };
  } catch (err) {
    // A judgement is an enhancement. Losing it must never fail a vetting run.
    log.warn(`judge failed for ${domain}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * How a judgement changes the outcome. A confident "farm" is a rejection no
 * score can override; "mixed" is a warning, priced in rather than fatal.
 */
export function applyJudgement(
  judgement: Judgement | null,
  authority: number | null,
): { reject: boolean; authority: number | null; note: string | null } {
  if (!judgement) return { reject: false, authority, note: null };

  if (judgement.verdict === 'farm' && judgement.confidence >= 0.6) {
    return { reject: true, authority: 0, note: `judged a link farm: ${judgement.why}` };
  }
  if (judgement.verdict === 'mixed') {
    return {
      reject: false,
      authority: authority === null ? null : Math.max(0, authority - 20),
      note: `weak moderation: ${judgement.why}`,
    };
  }
  return { reject: false, authority, note: judgement.why || null };
}
