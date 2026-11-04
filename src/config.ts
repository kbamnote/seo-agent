/**
 * Environment and client configuration.
 *
 * Client config is a JSON file per client in config/clients/, which is what
 * makes this multi-tenant: a second Tapify client is one file, not a code
 * change.
 */

import 'dotenv/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { PROJECT_ROOT } from './db/index.ts';

export const CLIENTS_DIR = resolve(PROJECT_ROOT, 'config/clients');
export const ARTIFACTS_DIR = resolve(PROJECT_ROOT, 'data/artifacts');
export const SESSIONS_DIR = resolve(PROJECT_ROOT, 'data/sessions');
export const SNAPSHOTS_DIR = resolve(PROJECT_ROOT, 'data/snapshots');

export type SubmissionType =
  | 'bookmarking'
  | 'profile'
  | 'blog'
  | 'mindmap'
  | 'ppt'
  | 'ping'
  | 'pdf'
  | 'directory'
  | 'image';

export interface KeywordConfig {
  keyword: string;
  targetUrl: string;
  priority?: number;
  anchors?: Record<string, string[]>;
}

export interface ClientConfig {
  id: string;
  name: string;
  siteUrl: string;
  niche?: string;
  city?: string;
  country?: string;
  brandNames?: string[];
  contact?: { email?: string; phone?: string; preferredUsername?: string };
  sourceSheetId?: string | null;
  agentSheetId?: string | null;
  keywords: KeywordConfig[];
  quotas?: Record<string, unknown>;
  approval?: { autoSubmit?: string[]; requiresApproval?: string[] };
}

export function loadClientConfig(id: string): ClientConfig {
  const path = resolve(CLIENTS_DIR, `${id}.json`);
  if (!existsSync(path)) {
    const available = listClientIds();
    throw new Error(
      `No client config at ${path}.` +
        (available.length ? ` Available: ${available.join(', ')}` : ' config/clients/ is empty.'),
    );
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as ClientConfig;
  if (!cfg.id || cfg.id !== id) {
    throw new Error(`Client config ${path} must have "id": "${id}".`);
  }
  if (!cfg.siteUrl) throw new Error(`Client config ${path} is missing siteUrl.`);
  if (!Array.isArray(cfg.keywords) || cfg.keywords.length === 0) {
    throw new Error(`Client config ${path} has no keywords.`);
  }
  return cfg;
}

export function listClientIds(): string[] {
  if (!existsSync(CLIENTS_DIR)) return [];
  return readdirSync(CLIENTS_DIR)
    // A leading underscore marks a file the loader ignores, which is how
    // _template.json can live beside the real configs without becoming a client.
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => basename(f, '.json'));
}

/** Reads an env var, with a clear error instead of a mystery undefined. */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set in .env.${hint ? ` ${hint}` : ''}`);
  }
  return value;
}

export const env = {
  get logLevel() {
    return process.env.LOG_LEVEL || 'info';
  },
  get headless() {
    return String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
  },
  get sourceSheetId() {
    return process.env.SOURCE_SHEET_ID?.trim() || null;
  },
  get agentSheetId() {
    return process.env.AGENT_SHEET_ID?.trim() || null;
  },
  get shareWith() {
    return process.env.SHEET_SHARE_WITH?.trim() || null;
  },
  get serviceAccountPath() {
    return process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || './secrets/service-account.json';
  },
  llm: {
    get provider() {
      return process.env.LLM_PROVIDER?.trim() || 'groq';
    },
    get baseUrl() {
      return process.env.LLM_BASE_URL?.trim() || 'https://api.groq.com/openai/v1';
    },
    get apiKey() {
      return process.env.LLM_API_KEY?.trim() || process.env.GROQ_API_KEY?.trim() || '';
    },
    get model() {
      return process.env.LLM_MODEL?.trim() || 'llama-3.3-70b-versatile';
    },
    get maxTokens() {
      return Number(process.env.LLM_MAX_TOKENS) || 2048;
    },
    /** Only sent when set; an endpoint that does not know it answers 400. */
    get reasoningEffort() {
      return process.env.LLM_REASONING_EFFORT?.trim() || '';
    },
  },
};

/** The nine tabs of the source tracker, mapped to internal submission types. */
export const SHEET_TAB_TO_TYPE: Record<string, SubmissionType> = {
  'Bookmarking submission': 'bookmarking',
  'Profile submission': 'profile',
  'Blog submission': 'blog',
  'Mindmap Submission': 'mindmap',
  'PPT submission': 'ppt',
  'Ping Submission': 'ping',
  'PDF Submission': 'pdf',
  'Directory Submisison': 'directory', // the tab name is misspelled in the sheet
  'Image submission': 'image',
};

export const TYPE_TO_SHEET_TAB: Record<SubmissionType, string> = {
  bookmarking: 'Bookmarking submission',
  profile: 'Profile submission',
  blog: 'Blog submission',
  mindmap: 'Mindmap Submission',
  ppt: 'PPT submission',
  ping: 'Ping Submission',
  pdf: 'PDF Submission',
  directory: 'Directory Submission',
  image: 'Image submission',
};

/**
 * Link-value weighting. Not every category is worth the same effort: a real
 * blog post or a profile on a platform with traffic moves rankings, a paste-site
 * bookmark mostly does not, and ping submission does nothing at all in 2026
 * (we keep the category only so the sheet's shape survives; the actual work is
 * IndexNow for the client's own site plus indexation checks on each backlink —
 * third-party URLs cannot be submitted to IndexNow at all; see
 * src/indexing/indexnow.ts).
 */
export const TYPE_VALUE_WEIGHT: Record<SubmissionType, number> = {
  blog: 1.0,
  profile: 0.8,
  directory: 0.7,
  bookmarking: 0.35,
  pdf: 0.3,
  ppt: 0.3,
  image: 0.25,
  mindmap: 0.2,
  ping: 0.05,
};
