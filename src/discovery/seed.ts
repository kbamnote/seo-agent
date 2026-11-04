/**
 * Seeds the catalog from config/seed-sites.json.
 *
 * The curated list exists so the agent is useful with no search API key at all,
 * and so the two fake "backlinks" found in the tracker (a whois page and an SEO
 * tool page) are blocklisted by name and can never be rediscovered as
 * candidates.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, get, run, tx } from '../db/index.ts';
import { log } from '../util/log.ts';

interface SeedSite {
  domain: string;
  name?: string;
  homeUrl?: string;
  categories?: string[];
  adapter?: string | null;
  manualOnly?: boolean;
  requiresAccount?: boolean;
  rejected?: boolean;
  rejectReason?: string;
  notes?: string;
}

export interface SeedStats {
  total: number;
  inserted: number;
  updated: number;
  blocklisted: number;
}

export function seedCatalog(): SeedStats {
  const path = resolve(PROJECT_ROOT, 'config/seed-sites.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as { sites: SeedSite[] };
  const stats: SeedStats = { total: file.sites.length, inserted: 0, updated: 0, blocklisted: 0 };

  tx(() => {
    for (const s of file.sites) {
      const domain = s.domain.toLowerCase().replace(/^www\./, '');
      const status = s.rejected ? 'rejected' : 'candidate';
      if (s.rejected) stats.blocklisted++;

      const existing = get<{ id: number; status: string }>('SELECT id, status FROM sites WHERE domain = ?', domain);

      if (existing) {
        // Keep whatever vetting has learned; only refresh the curated fields.
        run(
          `UPDATE sites SET
             name = COALESCE(name, ?), home_url = COALESCE(home_url, ?),
             categories = ?, adapter = COALESCE(?, adapter),
             manual_only = ?, requires_account = ?,
             notes = COALESCE(notes, ?),
             status = CASE WHEN ? = 'rejected' THEN 'rejected' ELSE status END,
             reject_reason = COALESCE(?, reject_reason),
             blocklisted = MAX(blocklisted, ?)
           WHERE id = ?`,
          s.name ?? null,
          s.homeUrl ?? null,
          JSON.stringify(s.categories ?? []),
          s.adapter ?? null,
          s.manualOnly ? 1 : 0,
          s.requiresAccount === false ? 0 : 1,
          s.notes ?? null,
          status,
          s.rejectReason ?? null,
          s.rejected ? 1 : 0,
          existing.id,
        );
        stats.updated++;
      } else {
        run(
          `INSERT INTO sites
             (domain, name, home_url, categories, adapter, manual_only, requires_account,
              status, reject_reason, notes, blocklisted, discovered_via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed-catalog')`,
          domain,
          s.name ?? domain,
          s.homeUrl ?? `https://${domain}/`,
          JSON.stringify(s.categories ?? []),
          s.adapter ?? null,
          s.manualOnly ? 1 : 0,
          s.requiresAccount === false ? 0 : 1,
          status,
          s.rejectReason ?? null,
          s.notes ?? null,
          s.rejected ? 1 : 0,
        );
        stats.inserted++;
      }
    }
  });

  log.info(
    `seeded catalog: ${stats.inserted} new, ${stats.updated} refreshed, ${stats.blocklisted} blocklisted`,
  );
  return stats;
}
