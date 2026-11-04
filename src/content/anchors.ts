/**
 * Anchor text rotation.
 *
 * The tracker used the exact target keyword as the anchor on every single
 * submission — sixteen bookmarks, four keywords, no variation. That pattern is
 * the most legible footprint in link building: a natural profile is mostly
 * branded and naked URLs, with exact-match in the minority.
 *
 * So the anchor is not chosen at random. It is chosen to pull the *live*
 * distribution towards the target, which means the agent self-corrects as it
 * goes and inherits the skew of whatever was built before it.
 */

import { all } from '../db/index.ts';
import type { KeywordConfig } from '../config.ts';
import type { AnchorChoice, AnchorKind } from './types.ts';
import { log } from '../util/log.ts';

/**
 * Target shape of the anchor profile. Branded and naked dominate because that
 * is what real citations look like: people link to a name or paste a URL, they
 * rarely link to "Full Stack Development in Nagpur".
 */
export const TARGET_MIX: Record<AnchorKind, number> = {
  branded: 0.35,
  naked: 0.25,
  partial: 0.25,
  exact: 0.15,
};

/**
 * Counted from content_items, not from submissions.
 *
 * Reading it from submissions was a bug: the anchor is decided when the asset is
 * written, and nothing is submitted until Phase 3 runs. The mix stayed empty, so
 * every single asset picked the same largest deficit and the first eight came out
 * branded — the exact uniformity this module exists to prevent.
 *
 * Rejected content is excluded: a rejected asset will never carry a link, so it
 * should not tilt the profile.
 */
export function currentMix(clientId: string): Record<AnchorKind, number> {
  const rows = all<{ anchor_kind: string | null; n: number }>(
    `SELECT anchor_kind, COUNT(*) AS n
       FROM content_items
      WHERE client_id = ? AND anchor_kind IS NOT NULL AND approval != 'rejected'
      GROUP BY anchor_kind`,
    clientId,
  );

  const counts: Record<AnchorKind, number> = { exact: 0, partial: 0, branded: 0, naked: 0 };
  let total = 0;
  for (const r of rows) {
    const kind = r.anchor_kind as AnchorKind;
    if (kind in counts) {
      counts[kind] = r.n;
      total += r.n;
    }
  }

  if (total === 0) return { exact: 0, partial: 0, branded: 0, naked: 0 };
  return {
    exact: counts.exact / total,
    partial: counts.partial / total,
    branded: counts.branded / total,
    naked: counts.naked / total,
  };
}

/** The kind furthest below its target share. */
export function nextAnchorKind(clientId: string): AnchorKind {
  const mix = currentMix(clientId);
  let best: { kind: AnchorKind; deficit: number } | null = null;

  for (const kind of Object.keys(TARGET_MIX) as AnchorKind[]) {
    const deficit = TARGET_MIX[kind] - mix[kind];
    if (!best || deficit > best.deficit) best = { kind, deficit };
  }
  return best!.kind;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Picks the actual anchor text. `variation` rotates within a kind so two
 * branded links do not both say the same thing.
 */
export function chooseAnchor(
  clientId: string,
  clientName: string,
  keyword: KeywordConfig,
  variation: number,
  forceKind?: AnchorKind,
): AnchorChoice {
  const kind = forceKind ?? nextAnchorKind(clientId);
  const configured = keyword.anchors ?? {};

  const pools: Record<AnchorKind, string[]> = {
    exact: configured.exact?.length ? configured.exact : [keyword.keyword],
    partial: configured.partial?.length ? configured.partial : [keyword.keyword.split(' in ')[0]!],
    branded: configured.branded?.length ? configured.branded : [clientName],
    naked: configured.naked?.length ? configured.naked : [hostOf(keyword.targetUrl)],
  };

  const pool = pools[kind];
  const text = pool[(variation - 1) % pool.length] ?? pool[0]!;

  log.debug(`anchor: ${kind} → "${text}"`);
  return { text, kind, targetUrl: keyword.targetUrl };
}

/** Console view of how the profile is shaping up. */
export function printMix(clientId: string) {
  const mix = currentMix(clientId);
  log.heading('Anchor profile');
  for (const kind of Object.keys(TARGET_MIX) as AnchorKind[]) {
    const have = Math.round(mix[kind] * 100);
    const want = Math.round(TARGET_MIX[kind] * 100);
    const bar = '█'.repeat(Math.round(have / 4)).padEnd(25, '·');
    console.log(`  ${kind.padEnd(8)} ${bar} ${String(have).padStart(3)}%  target ${want}%`);
  }
  console.log(`\n  next anchor will be: ${nextAnchorKind(clientId)}\n`);
}
