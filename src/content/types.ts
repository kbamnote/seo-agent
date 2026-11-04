/**
 * Content factory types.
 */

import type { SubmissionType } from '../config.ts';

export type AnchorKind = 'exact' | 'partial' | 'branded' | 'naked';

export interface AnchorChoice {
  text: string;
  kind: AnchorKind;
  targetUrl: string;
}

export interface GenerateRequest {
  clientId: string;
  type: SubmissionType;
  keyword: string;
  keywordId: number | null;
  targetUrl: string;
  /** Optional: the platform this asset is for, so it can be tailored and never reused. */
  siteDomain?: string;
  siteId?: number | null;
  /** nth asset for this keyword+type; drives "do not repeat these titles". */
  variation: number;
}

/** What every generator returns, whatever the medium. */
export interface GeneratedAsset {
  title: string;
  /** Plain text or markdown body. Always present, even for file assets — it is
   *  what goes in the platform's description field, which is the part that is
   *  actually crawled for a PDF or a deck. */
  body: string;
  anchor: AnchorChoice;
  /** Absolute path of a produced file, when the type needs one. */
  assetPath?: string;
  wordCount: number;
  generator: 'llm' | 'template';
  model?: string;
  meta: Record<string, unknown>;
}

export interface ArticleDraft {
  title: string;
  metaDescription: string;
  sections: Array<{ heading: string; paragraphs: string[] }>;
  faq: Array<{ q: string; a: string }>;
  takeaway: string;
}

export interface ClientContentRules {
  tone?: string;
  audience?: string;
  facts?: string[];
  forbidden?: string[];
  mustInclude?: string[];
}
