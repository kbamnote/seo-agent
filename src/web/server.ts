/**
 * The local web UI.
 *
 * A zero-dependency HTTP server over the same SQLite database the CLI uses.
 * No framework, no build step, no new native modules — the same constraints
 * that kept the rest of this project installable on Windows.
 *
 * Three deliberate limits:
 *
 *   1. **It binds to 127.0.0.1 only.** Not configurable.
 *   2. **It never runs a command.** The first draft of this file had endpoints
 *      that spawned the CLI so you could click "submit" in the browser, with
 *      the output streamed back. That is a remote-code-execution surface: an
 *      HTTP route that starts processes is exactly the thing worth attacking,
 *      and "it's only on localhost" is how that always gets argued. Anything
 *      that generates, submits or publishes stays in the terminal, where it is
 *      deliberate. The UI shows you the command to run.
 *   3. **It never serves a password.** The vault stays behind the CLI.
 *
 * What it does do is the part that was genuinely painful in a terminal: reading
 * an article properly before approving it, and working the manual queue.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { PROJECT_ROOT, all, get, initSchema, run } from '../db/index.ts';
import { listClientIds, loadClientConfig } from '../config.ts';
import { quotaReport, pickWork } from '../submit/runner.ts';
import { adapterFor } from '../submit/adapters/index.ts';
import { runDoctor } from '../report/doctor.ts';
import { currentMix, TARGET_MIX } from '../content/anchors.ts';
import { log } from '../util/log.ts';

const PUBLIC_DIR = resolve(PROJECT_ROOT, 'src/web/public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ── Queries ─────────────────────────────────────────────────────────────────

function clientId(url: URL): string {
  const asked = url.searchParams.get('client');
  if (asked) return asked;
  const ids = listClientIds();
  if (!ids.length) throw new Error('No clients configured in config/clients/.');
  return ids[0]!;
}

function overview(id: string) {
  const n = (sql: string, ...p: Array<string | number>) => get<{ n: number }>(sql, ...p)?.n ?? 0;
  const latestNote = (like: string) =>
    n(
      `SELECT COUNT(*) AS n FROM submissions s
         JOIN verifications v ON v.id = (
              SELECT id FROM verifications w WHERE w.submission_id = s.id
               ORDER BY checked_at DESC, id DESC LIMIT 1)
        WHERE s.client_id = ? AND v.note LIKE ?`,
      id,
      like,
    );

  const cfg = loadClientConfig(id);
  const mix = currentMix(id);

  return {
    client: { id, name: cfg.name, siteUrl: cfg.siteUrl },
    links: {
      verified: n("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status = 'verified'", id),
      waiting: n(
        "SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status IN ('submitted','needs_assist','manual_queue')",
        id,
      ),
      lost: n("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status = 'lost'", id),
      unknown: latestNote('%refused us%'),
      mentions: latestNote('%plain text%'),
      unverifiable: n("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status = 'unverifiable'", id),
      dofollow: n(
        `SELECT COUNT(*) AS n FROM submissions s JOIN verifications v ON v.id = (
            SELECT id FROM verifications w WHERE w.submission_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1)
          WHERE s.client_id = ? AND s.status = 'verified' AND v.rel = 'dofollow'`,
        id,
      ),
    },
    content: {
      total: n('SELECT COUNT(*) AS n FROM content_items WHERE client_id = ?', id),
      pending: n("SELECT COUNT(*) AS n FROM content_items WHERE client_id = ? AND approval = 'pending'", id),
      ready: n(
        `SELECT COUNT(*) AS n FROM content_items
          WHERE client_id = ? AND approval IN ('approved','not_required') AND generator != 'template'
            AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.content_id = content_items.id AND s.status != 'failed')`,
        id,
      ),
    },
    catalog: all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM sites GROUP BY status ORDER BY n DESC',
    ),
    anchors: (Object.keys(TARGET_MIX) as Array<keyof typeof TARGET_MIX>).map((kind) => ({
      kind,
      have: Math.round((mix[kind] ?? 0) * 100),
      target: Math.round(TARGET_MIX[kind] * 100),
    })),
    quota: quotaReport(cfg),
  };
}

function contentList(id: string, filter: string) {
  const where =
    filter === 'pending'
      ? "AND c.approval = 'pending'"
      : filter === 'approved'
        ? "AND c.approval IN ('approved','not_required')"
        : filter === 'rejected'
          ? "AND c.approval = 'rejected'"
          : '';

  return all(
    `SELECT c.id, c.type, c.title, c.approval, c.generator, c.word_count AS words,
            c.anchor_text AS anchor, c.anchor_kind AS anchorKind, c.asset_path AS assetPath,
            c.created_at AS createdAt, k.keyword, si.domain AS site,
            (SELECT COUNT(*) FROM submissions s WHERE s.content_id = c.id AND s.status != 'failed') AS sent
       FROM content_items c
       LEFT JOIN keywords k ON k.id = c.keyword_id
       LEFT JOIN sites si ON si.id = c.site_id
      WHERE c.client_id = ? ${where}
      ORDER BY c.id DESC LIMIT 200`,
    id,
  );
}

function contentDetail(contentId: number) {
  const row = get<{
    id: number;
    type: string;
    title: string;
    body: string;
    asset_path: string | null;
    anchor_text: string;
    anchor_kind: string;
    target_url: string;
    approval: string;
    generator: string;
    model: string | null;
    word_count: number | null;
    variation: number;
    meta_json: string | null;
    keyword: string | null;
    site: string | null;
  }>(
    `SELECT c.*, k.keyword, si.domain AS site
       FROM content_items c
       LEFT JOIN keywords k ON k.id = c.keyword_id
       LEFT JOIN sites si ON si.id = c.site_id
      WHERE c.id = ?`,
    contentId,
  );
  if (!row) return null;

  // For an article the markdown file is the thing to read; for everything else
  // the body column is what goes in the platform's own field.
  let text = row.body;
  if (row.asset_path && row.asset_path.endsWith('.md') && existsSync(row.asset_path)) {
    text = readFileSync(row.asset_path, 'utf8');
  }

  let files: string[] = [];
  try {
    files = (JSON.parse(row.meta_json || '{}').files ?? []) as string[];
  } catch {
    /* meta is advisory */
  }

  return { ...row, text, files };
}

function manualQueue(id: string) {
  return all(
    `SELECT s.id, s.type, s.status, s.submitted_url AS submittedUrl,
            si.domain AS site, c.title, c.body, c.anchor_text AS anchor,
            c.target_url AS targetUrl, c.asset_path AS assetPath, k.keyword
       FROM submissions s
       JOIN sites si ON si.id = s.site_id
       LEFT JOIN content_items c ON c.id = s.content_id
       LEFT JOIN keywords k ON k.id = s.keyword_id
      WHERE s.client_id = ? AND s.status = 'manual_queue'
      ORDER BY s.id DESC`,
    id,
  );
}

function linksList(id: string) {
  return all(
    `SELECT s.id, s.type, s.status, s.submitted_url AS url, s.operator, s.source,
            s.submitted_at AS submittedAt, si.domain AS site,
            v.link_present AS linkPresent, v.rel, v.http_status AS httpStatus,
            v.checked_at AS checkedAt, v.note
       FROM submissions s
       LEFT JOIN sites si ON si.id = s.site_id
       LEFT JOIN verifications v ON v.id = (
            SELECT id FROM verifications w WHERE w.submission_id = s.id
             ORDER BY checked_at DESC, id DESC LIMIT 1)
      WHERE s.client_id = ?
      ORDER BY (s.status = 'verified') DESC, s.id DESC
      LIMIT 300`,
    id,
  );
}

function sitesList(url: URL) {
  const status = url.searchParams.get('status');
  const type = url.searchParams.get('type');
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (type) {
    clauses.push('categories LIKE ?');
    params.push(`%"${type}"%`);
  }

  return all(
    `SELECT domain, name, status, score, authority, categories, manual_only AS manualOnly,
            blocklisted, adapter, captcha_vendor AS captcha, reject_reason AS reason,
            consecutive_failures AS failures, notes, home_url AS homeUrl
       FROM sites
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      -- Usable sites first. A blocklisted domain can still score well as a
      -- website -- whois.com led the list -- which is misleading at a glance.
      ORDER BY blocklisted ASC,
               (status = 'rejected') ASC,
               (score IS NULL),
               (0.45 * COALESCE(score,0) + 0.55 * COALESCE(authority,50)) DESC
      LIMIT 300`,
    ...params,
  );
}

function queueList(id: string) {
  const cfg = loadClientConfig(id);
  return pickWork(cfg, { limit: 50 }).map((w) => {
    const adapter = adapterFor(w.siteDomain, w.siteAdapter);
    return {
      contentId: w.contentId,
      type: w.type,
      title: w.title,
      site: w.siteDomain,
      anchor: w.anchorText,
      adapter: adapter.id,
      confidence: adapter.confidence,
    };
  });
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function serveStatic(res: ServerResponse, pathname: string) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // normalize before joining, so ../ cannot climb out of the public folder.
  const target = join(PUBLIC_DIR, normalize(rel));
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
}

/**
 * HTTP Basic auth, required whenever the server is not on loopback.
 *
 * This UI approves content for publication and edits the site catalog. On a
 * laptop, "only reachable from this machine" is the whole protection. The
 * moment it is hosted, that protection is gone and anyone with the URL can
 * approve articles in the client's name — so credentials become mandatory, and
 * the server refuses to start without them rather than coming up unprotected.
 */
function credentials(): { user: string; pass: string } | null {
  const user = process.env.WEB_USER?.trim();
  const pass = process.env.WEB_PASSWORD?.trim();
  return user && pass ? { user, pass } : null;
}

/** Constant-time compare, so a wrong password cannot be found by timing. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authorised(req: IncomingMessage): boolean {
  const creds = credentials();
  if (!creds) return true; // loopback-only mode; startup already enforced this

  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('basic ')) return false;

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const split = decoded.indexOf(':');
  if (split < 0) return false;

  // Both compared, never short-circuited on the username.
  const userOk = same(decoded.slice(0, split), creds.user);
  const passOk = same(decoded.slice(split + 1), creds.pass);
  return userOk && passOk;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (!authorised(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="SEO agent", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    res.end('authentication required');
    return;
  }

  if (!path.startsWith('/api/')) return serveStatic(res, path);

  try {
    if (req.method === 'GET') {
      if (path === '/api/overview') return json(res, 200, overview(clientId(url)));
      if (path === '/api/clients') return json(res, 200, listClientIds());
      if (path === '/api/content')
        return json(res, 200, contentList(clientId(url), url.searchParams.get('filter') ?? 'pending'));
      if (path === '/api/manual') return json(res, 200, manualQueue(clientId(url)));
      if (path === '/api/links') return json(res, 200, linksList(clientId(url)));
      if (path === '/api/sites') return json(res, 200, sitesList(url));
      if (path === '/api/queue') return json(res, 200, queueList(clientId(url)));
      if (path === '/api/doctor') return json(res, 200, runDoctor(clientId(url)));

      const detail = /^\/api\/content\/(\d+)$/.exec(path);
      if (detail) {
        const item = contentDetail(Number(detail[1]));
        return item ? json(res, 200, item) : json(res, 404, { error: 'no such content item' });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      const approve = /^\/api\/content\/(\d+)\/(approve|reject)$/.exec(path);
      if (approve) {
        const id = Number(approve[1]);
        const decision = approve[2] === 'approve' ? 'approved' : 'rejected';
        const row = get<{ generator: string }>('SELECT generator FROM content_items WHERE id = ?', id);
        if (!row) return json(res, 404, { error: 'no such content item' });
        if (decision === 'approved' && row.generator === 'template') {
          return json(res, 400, {
            error: 'Template output is placeholder text and is never publishable. Regenerate it.',
          });
        }
        run('UPDATE content_items SET approval = ? WHERE id = ?', decision, id);
        return json(res, 200, { id, approval: decision });
      }

      const record = /^\/api\/submissions\/(\d+)\/record$/.exec(path);
      if (record) {
        const id = Number(record[1]);
        const posted = String(body.url ?? '').trim();
        if (!/^https?:\/\//i.test(posted)) return json(res, 400, { error: `"${posted}" is not a URL` });
        const changed = run(
          `UPDATE submissions SET submitted_url = ?, status = 'submitted',
             operator = COALESCE(?, operator), submitted_at = datetime('now'),
             updated_at = datetime('now')
           WHERE id = ?`,
          posted,
          body.operator ? String(body.operator) : null,
          id,
        );
        if (!changed.changes) return json(res, 404, { error: 'no such submission' });
        return json(res, 200, { id, url: posted, status: 'submitted' });
      }

      const siteStatus = /^\/api\/sites\/([^/]+)\/status$/.exec(path);
      if (siteStatus) {
        const domain = decodeURIComponent(siteStatus[1]!).toLowerCase().replace(/^www\./, '');
        const status = String(body.status ?? '');
        if (!['vetted', 'rejected', 'active', 'blocked', 'marginal'].includes(status)) {
          return json(res, 400, { error: `"${status}" is not a status the UI may set` });
        }
        const flag = get<{ blocklisted: number }>('SELECT blocklisted FROM sites WHERE domain = ?', domain);
        if (!flag) return json(res, 404, { error: 'no such site' });
        if (flag.blocklisted && status !== 'rejected') {
          return json(res, 400, { error: `${domain} is blocklisted and cannot be revived here.` });
        }
        run(
          'UPDATE sites SET status = ?, reject_reason = ? WHERE domain = ?',
          status,
          body.reason ? String(body.reason) : null,
          domain,
        );
        return json(res, 200, { domain, status });
      }
    }

    json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (err) {
    log.error(err instanceof Error ? err.message : err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startWeb(port = 4317, host?: string): Promise<string> {
  initSchema();

  const bind = host ?? process.env.WEB_HOST?.trim() ?? '127.0.0.1';
  const loopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';

  if (!loopback && !credentials()) {
    throw new Error(
      [
        `Refusing to listen on ${bind} without credentials.`,
        'This UI approves content for publication and edits the catalog, so on any',
        'address but loopback it must be protected. Set WEB_USER and WEB_PASSWORD,',
        'or leave WEB_HOST unset to stay on 127.0.0.1.',
      ].join('\n'),
    );
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(err);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(port, bind, () => {
      const shown = loopback ? `http://127.0.0.1:${port}` : `http://${bind}:${port}`;
      log.info(`web UI on ${shown}${credentials() ? ' (password protected)' : ' (loopback only)'}`);
      resolvePromise(shown);
    });
  });
}
