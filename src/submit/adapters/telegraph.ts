/**
 * Telegraph (telegra.ph) — the one adapter with no guesswork in it.
 *
 * Telegraph publishes a documented public API intended for exactly this, so
 * there is no browser, no selectors to rot, no CAPTCHA and no login. It is the
 * adapter to reach for when proving the pipeline end to end.
 *
 * The "account" here is an anonymous author token, not a user account: no email,
 * no password, no identity. The token is stored in the vault anyway, because
 * reusing it keeps every post under one author page — which is itself a profile
 * link, and makes the posts look like a publisher rather than litter.
 *
 * Honest about value: Telegraph pages index inconsistently and carry modest
 * weight. This is a cheap, reliable floor, not a cornerstone.
 */

import { get, run } from '../../db/index.ts';
import { decryptSecret, encryptSecret, vaultReady } from '../../util/vault.ts';
import { log } from '../../util/log.ts';
import type { SiteAdapter, SubmitContext, SubmitOutcome } from './types.ts';

const API = 'https://api.telegra.ph';

interface TelegraphNode {
  tag: string;
  attrs?: Record<string, string>;
  children?: Array<TelegraphNode | string>;
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!json.ok) throw new Error(`telegra.ph ${method} failed: ${json.error ?? res.status}`);
  return json.result as T;
}

/** One author token per client, kept in the accounts table. */
async function tokenFor(ctx: SubmitContext, siteId: number): Promise<string> {
  const row = get<{ id: number; secret_enc: string | null }>(
    'SELECT id, secret_enc FROM accounts WHERE client_id = ? AND site_id = ? LIMIT 1',
    ctx.cfg.id,
    siteId,
  );
  if (row?.secret_enc && vaultReady()) {
    try {
      return decryptSecret(row.secret_enc);
    } catch {
      log.warn('stored telegra.ph token could not be decrypted; creating a new author');
    }
  }

  const account = await call<{ access_token: string; auth_url?: string }>('createAccount', {
    short_name: ctx.cfg.name.slice(0, 32),
    author_name: ctx.cfg.name.slice(0, 128),
    author_url: ctx.cfg.siteUrl,
  });

  const enc = vaultReady() ? encryptSecret(account.access_token) : null;
  if (row) run('UPDATE accounts SET secret_enc = ?, status = ? WHERE id = ?', enc, 'active', row.id);
  else
    run(
      `INSERT INTO accounts (client_id, site_id, email, username, secret_enc, status, notes)
       VALUES (?, ?, NULL, ?, ?, 'active', 'telegra.ph anonymous author token')`,
      ctx.cfg.id,
      siteId,
      ctx.cfg.name.slice(0, 32),
      enc,
    );

  if (!vaultReady()) {
    log.warn('VAULT_KEY not set — the telegra.ph author token was not stored, so the next post will be a new author.');
  }
  return account.access_token;
}

/**
 * Markdown-ish body to Telegraph's node format. Telegraph accepts a small tag
 * set only, so anything fancier is flattened rather than rejected.
 */
export function bodyToNodes(markdown: string): Array<TelegraphNode | string> {
  const nodes: Array<TelegraphNode | string> = [];

  for (const block of markdown.split(/\n{2,}/)) {
    const text = block.trim();
    if (!text) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      // Telegraph supports h3 and h4 only; h1/h2 become h3.
      const level = heading[1]!.length <= 2 ? 'h3' : 'h4';
      nodes.push({ tag: level, children: [heading[2]!] });
      continue;
    }

    nodes.push({ tag: 'p', children: inline(text) });
  }
  return nodes;
}

/** Handles the two inline forms the renderer emits: links and bold. */
function inline(text: string): Array<TelegraphNode | string> {
  const out: Array<TelegraphNode | string> = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] && match[2]) out.push({ tag: 'a', attrs: { href: match[2] }, children: [match[1]] });
    else if (match[3]) out.push({ tag: 'strong', children: [match[3]] });
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

export const telegraphAdapter: SiteAdapter = {
  id: 'telegraph',
  categories: ['blog', 'bookmarking'],
  requiresAccount: false,
  apiOnly: true,
  confidence: 'api',

  async submit(ctx: SubmitContext): Promise<SubmitOutcome> {
    const site = get<{ id: number }>('SELECT id FROM sites WHERE domain = ?', 'telegra.ph');
    if (!site) return { status: 'failed', note: 'telegra.ph is not in the catalog' };

    try {
      const token = await tokenFor(ctx, site.id);
      const content = bodyToNodes(ctx.payload.body);

      // The body must carry the link; if the renderer did not put one in, add a
      // citation line rather than publishing a page that links nowhere.
      const hasLink = JSON.stringify(content).includes(ctx.payload.url);
      if (!hasLink) {
        content.push({
          tag: 'p',
          children: [
            { tag: 'a', attrs: { href: ctx.payload.url }, children: [ctx.payload.anchorText] },
          ],
        });
      }

      const page = await call<{ url: string; path: string }>('createPage', {
        access_token: token,
        title: ctx.payload.title.slice(0, 256),
        author_name: ctx.cfg.name.slice(0, 128),
        author_url: ctx.cfg.siteUrl,
        content,
        return_content: false,
      });

      return { status: 'submitted', liveUrl: page.url, note: 'telegra.ph API' };
    } catch (err) {
      return { status: 'failed', note: err instanceof Error ? err.message : String(err) };
    }
  },
};
