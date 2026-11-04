/**
 * Adapter contract.
 *
 * An adapter knows one platform's submission flow. Everything without one falls
 * through to `generic`, which drives the form filler.
 *
 * `submit` returns rather than throws for the ordinary failure modes, because
 * "this needs a human" and "the platform rejected it" are results worth
 * recording, not exceptions.
 */

import type { Page } from 'playwright';
import type { ClientConfig, SubmissionType } from '../../config.ts';
import type { SubmissionPayload } from '../forms.ts';

export interface SubmitContext {
  page: Page;
  payload: SubmissionPayload;
  cfg: ClientConfig;
  siteDomain: string;
  /** The submission URL the catalog recorded during vetting, if any. */
  submitUrl?: string | null;
  /** Present when the platform needs an account; password is already decrypted. */
  account?: { username: string; email: string | null; password: string } | null;
  /** True when this is the first time we have used this platform. */
  firstUse: boolean;
}

export type SubmitStatus = 'submitted' | 'needs_assist' | 'failed' | 'skipped';

export interface SubmitOutcome {
  status: SubmitStatus;
  /** The published page that should carry the link. */
  liveUrl?: string;
  note?: string;
  screenshot?: string | null;
}

export interface SiteAdapter {
  id: string;
  /** What this adapter can submit. */
  categories: SubmissionType[];
  requiresAccount: boolean;
  /** True when the adapter talks to an API and needs no browser at all. */
  apiOnly?: boolean;
  /**
   * How sure we are of this adapter's selectors.
   *  - 'api'        documented API, nothing to break
   *  - 'confirmed'  watched working against the live site
   *  - 'untested'   written from the platform's structure, needs one supervised run
   */
  confidence: 'api' | 'confirmed' | 'untested';
  submit(ctx: SubmitContext): Promise<SubmitOutcome>;
}
