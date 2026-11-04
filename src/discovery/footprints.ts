/**
 * Footprint library: the search queries that surface submission sites.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../db/index.ts';
import type { ClientConfig, SubmissionType } from '../config.ts';

export interface Footprint {
  id: string;
  query: string;
  weight?: number;
}

interface FootprintFile {
  [key: string]: Footprint[] | unknown;
}

let cached: FootprintFile | null = null;

export function loadFootprints(): FootprintFile {
  if (cached) return cached;
  const path = resolve(PROJECT_ROOT, 'config/footprints.json');
  cached = JSON.parse(readFileSync(path, 'utf8')) as FootprintFile;
  return cached;
}

export function footprintsFor(type: SubmissionType): Footprint[] {
  const file = loadFootprints();
  const list = file[type];
  return Array.isArray(list) ? (list as Footprint[]) : [];
}

/** Fills {niche} {city} {country} {brand} {keyword}. */
export function expandQuery(template: string, cfg: ClientConfig, keyword?: string): string {
  const niche = cfg.niche?.split('(')[0]?.trim() || cfg.name;
  return template
    .replace(/\{niche\}/g, niche)
    .replace(/\{city\}/g, cfg.city ?? '')
    .replace(/\{country\}/g, cfg.country ?? '')
    .replace(/\{brand\}/g, cfg.name)
    .replace(/\{keyword\}/g, keyword ?? cfg.keywords[0]?.keyword ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Expands a type's footprints into concrete queries, heaviest first, so a small
 * `--queries` budget spends itself on the footprints that actually work.
 */
export function plannedQueries(
  type: SubmissionType,
  cfg: ClientConfig,
  max: number,
): Array<{ id: string; query: string }> {
  const out: Array<{ id: string; query: string }> = [];
  const sorted = [...footprintsFor(type)].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));

  for (const fp of sorted) {
    const query = expandQuery(fp.query, cfg);
    if (query) out.push({ id: fp.id, query });
    if (out.length >= max) break;
  }

  // Keyword-specific variants fill any remaining budget — different keywords
  // surface different sites, which is the point of having four of them.
  if (out.length < max) {
    for (const kw of cfg.keywords) {
      for (const fp of sorted) {
        if (!/\{keyword\}/.test(fp.query)) continue;
        const query = expandQuery(fp.query, cfg, kw.keyword);
        if (query && !out.some((q) => q.query === query)) out.push({ id: `${fp.id}:${kw.keyword}`, query });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}
