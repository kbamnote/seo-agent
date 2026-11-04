/**
 * Adapter registry.
 *
 * A site row's `adapter` column names one of these; anything else gets
 * `generic`. The seed catalog names adapters for eight platforms, but only the
 * ones listed here exist — the rest resolve to generic until someone writes
 * them, which is the correct behaviour rather than a crash.
 */

import type { SubmissionType } from '../../config.ts';
import { genericAdapter } from './generic.ts';
import { justpasteAdapter, writeasAdapter } from './nologin.ts';
import { telegraphAdapter } from './telegraph.ts';
import type { SiteAdapter } from './types.ts';

const REGISTRY: SiteAdapter[] = [telegraphAdapter, justpasteAdapter, writeasAdapter, genericAdapter];

const BY_ID = new Map(REGISTRY.map((a) => [a.id, a]));

/** Domain to adapter, for platforms whose adapter is obvious from the host. */
const BY_DOMAIN = new Map<string, string>([
  ['telegra.ph', 'telegraph'],
  ['justpaste.it', 'justpaste'],
  ['write.as', 'writeas'],
]);

export function adapterFor(domain: string, named?: string | null): SiteAdapter {
  const byDomain = BY_DOMAIN.get(domain.replace(/^www\./, ''));
  if (byDomain) return BY_ID.get(byDomain)!;
  if (named && BY_ID.has(named)) return BY_ID.get(named)!;
  return genericAdapter;
}

export function listAdapters(): Array<{
  id: string;
  categories: SubmissionType[];
  requiresAccount: boolean;
  confidence: string;
  apiOnly: boolean;
}> {
  return REGISTRY.map((a) => ({
    id: a.id,
    categories: a.categories,
    requiresAccount: a.requiresAccount,
    confidence: a.confidence,
    apiOnly: Boolean(a.apiOnly),
  }));
}

export { genericAdapter, justpasteAdapter, telegraphAdapter, writeasAdapter };
export type { SiteAdapter, SubmitContext, SubmitOutcome } from './types.ts';
