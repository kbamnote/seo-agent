/**
 * Content factory orchestrator.
 *
 * One call produces one asset for one keyword, for one platform, and records it.
 * Two rules it enforces that the manual workflow did not:
 *
 *   1. **Nothing is reused.** Every submission gets its own asset. The same
 *      blurb on twelve bookmarking sites is twelve copies of the same page, and
 *      eleven of them are worthless. `variation` counts what already exists for
 *      a keyword and type, and the previous titles are handed to the writer with
 *      instructions not to rewrite them.
 *   2. **Template output can never auto-publish.** It lands in the approval
 *      queue regardless of the client's autoSubmit settings.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACTS_DIR, type ClientConfig, type SubmissionType } from '../config.ts';
import { all, get, run } from '../db/index.ts';
import { log } from '../util/log.ts';
import { chooseAnchor } from './anchors.ts';
import { buildImage } from './assets/image.ts';
import { buildMindmap } from './assets/mindmap.ts';
import { buildPdf } from './assets/pdf.ts';
import { buildPptx } from './assets/ppt.ts';
import { articleToHtml, articleToMarkdown, articleWordCount, slugify, wordsIn } from './render.ts';
import type { AnchorKind, GenerateRequest } from './types.ts';
import { writeArticle, writeMindmap, writeOutline, writeShort } from './writer.ts';

export interface GenerateOptions {
  type: SubmissionType;
  keyword?: string;
  siteDomain?: string;
  anchorKind?: AnchorKind;
}

export interface GenerateResult {
  contentId: number;
  type: SubmissionType;
  keyword: string;
  title: string;
  anchorText: string;
  anchorKind: string;
  approval: string;
  generator: 'llm' | 'template';
  wordCount: number;
  files: string[];
}

const UPLOAD_TYPES: SubmissionType[] = ['pdf', 'ppt', 'image', 'mindmap'];

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function resolveKeyword(cfg: ClientConfig, wanted?: string) {
  if (!wanted) {
    // Highest priority keyword with the fewest assets so far: spreads the work
    // instead of writing five articles about one thing.
    const counts = new Map<string, number>();
    for (const row of all<{ keyword_text: string; n: number }>(
      `SELECT k.keyword AS keyword_text, COUNT(c.id) AS n
         FROM keywords k LEFT JOIN content_items c ON c.keyword_id = k.id
        WHERE k.client_id = ? GROUP BY k.keyword`,
      cfg.id,
    )) {
      counts.set(normalise(row.keyword_text), row.n);
    }
    const sorted = [...cfg.keywords].sort((a, b) => {
      const byCount = (counts.get(normalise(a.keyword)) ?? 0) - (counts.get(normalise(b.keyword)) ?? 0);
      if (byCount !== 0) return byCount;
      return (a.priority ?? 3) - (b.priority ?? 3);
    });
    return sorted[0]!;
  }

  const target = normalise(wanted);
  const exact = cfg.keywords.find((k) => normalise(k.keyword) === target);
  if (exact) return exact;
  const partial = cfg.keywords.find(
    (k) => normalise(k.keyword).includes(target) || target.includes(normalise(k.keyword)),
  );
  if (partial) return partial;
  throw new Error(
    `"${wanted}" is not a configured keyword. Available:\n` +
      cfg.keywords.map((k) => `  - ${k.keyword}`).join('\n'),
  );
}

function artifactPath(clientId: string, type: string, slug: string, variation: number, ext: string) {
  const dir = resolve(ARTIFACTS_DIR, clientId, type);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${slug}-v${variation}${ext}`);
}

export async function generateOne(
  cfg: ClientConfig,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const keyword = resolveKeyword(cfg, opts.keyword);
  const keywordRow = get<{ id: number }>(
    'SELECT id FROM keywords WHERE client_id = ? AND keyword = ?',
    cfg.id,
    keyword.keyword,
  );

  const existing = all<{ title: string }>(
    `SELECT title FROM content_items
      WHERE client_id = ? AND type = ? AND keyword_id IS ?
      ORDER BY id DESC LIMIT 8`,
    cfg.id,
    opts.type,
    keywordRow?.id ?? null,
  );

  const variation = existing.length + 1;
  const siteRow = opts.siteDomain
    ? get<{ id: number }>('SELECT id FROM sites WHERE domain = ?', opts.siteDomain.replace(/^www\./, ''))
    : undefined;

  const req: GenerateRequest = {
    clientId: cfg.id,
    type: opts.type,
    keyword: keyword.keyword,
    keywordId: keywordRow?.id ?? null,
    targetUrl: keyword.targetUrl,
    siteDomain: opts.siteDomain,
    siteId: siteRow?.id ?? null,
    variation,
  };

  const anchor = chooseAnchor(cfg.id, cfg.name, keyword, variation, opts.anchorKind);
  const avoid = existing.map((e) => e.title).filter(Boolean);
  const slug = slugify(`${keyword.keyword}-${opts.siteDomain ?? opts.type}`);
  const files: string[] = [];

  let title = '';
  let body = '';
  let wordCount = 0;
  let generator: 'llm' | 'template' = 'template';
  let model: string | undefined;
  let assetPath: string | undefined;
  const meta: Record<string, unknown> = {
    site: opts.siteDomain ?? null,
    variation,
    targetUrl: keyword.targetUrl,
  };

  if (opts.type === 'blog') {
    const { value: draft, generator: g, model: m } = await writeArticle(cfg, req, avoid);
    generator = g;
    model = m;
    title = draft.title;
    body = articleToMarkdown(draft, anchor);
    wordCount = articleWordCount(draft);

    const mdPath = artifactPath(cfg.id, 'blog', slug, variation, '.md');
    const htmlPath = artifactPath(cfg.id, 'blog', slug, variation, '.html');
    writeFileSync(mdPath, `${body}\n`, 'utf8');
    writeFileSync(htmlPath, `${articleToHtml(draft, anchor)}\n`, 'utf8');
    files.push(mdPath, htmlPath);
    assetPath = mdPath;
    meta.metaDescription = draft.metaDescription;
    meta.faqCount = draft.faq.length;
  } else if (opts.type === 'pdf') {
    const { value: draft, generator: g, model: m } = await writeArticle(cfg, req, avoid);
    const short = await writeShort(cfg, req, avoid);
    generator = g === 'llm' && short.generator === 'llm' ? 'llm' : 'template';
    model = m ?? short.model;
    title = short.value.title || draft.title;
    body = short.value.body;
    wordCount = articleWordCount(draft);

    const pdfPath = artifactPath(cfg.id, 'pdf', slug, variation, '.pdf');
    await buildPdf(draft, anchor, cfg, pdfPath);
    files.push(pdfPath);
    assetPath = pdfPath;
    meta.documentTitle = draft.title;
  } else if (opts.type === 'ppt') {
    const { value: outline, generator: g, model: m } = await writeOutline(cfg, req);
    const short = await writeShort(cfg, req, avoid);
    generator = g === 'llm' && short.generator === 'llm' ? 'llm' : 'template';
    model = m ?? short.model;
    title = short.value.title || outline.title;
    body = short.value.body;
    wordCount = wordsIn(body) + outline.slides.reduce((n, s) => n + wordsIn(s.bullets.join(' ')), 0);

    const pptPath = artifactPath(cfg.id, 'ppt', slug, variation, '.pptx');
    await buildPptx(outline, anchor, cfg, pptPath);
    files.push(pptPath);
    assetPath = pptPath;
    meta.slides = outline.slides.length;
  } else if (opts.type === 'image') {
    const { value: outline, generator: g, model: m } = await writeOutline(cfg, req);
    const short = await writeShort(cfg, req, avoid);
    generator = g === 'llm' && short.generator === 'llm' ? 'llm' : 'template';
    model = m ?? short.model;
    title = short.value.title || outline.title;
    body = short.value.body;
    wordCount = wordsIn(body);

    const imgPath = artifactPath(cfg.id, 'image', slug, variation, '.jpg');
    const written = await buildImage(
      {
        title: outline.title,
        points: outline.slides.slice(0, 5).map((s) => s.heading),
        caption: body,
      },
      anchor,
      cfg,
      imgPath,
    );
    files.push(written);
    assetPath = written;
  } else if (opts.type === 'mindmap') {
    const { value: outline, generator: g, model: m } = await writeMindmap(cfg, req);
    const short = await writeShort(cfg, req, avoid);
    generator = g === 'llm' && short.generator === 'llm' ? 'llm' : 'template';
    model = m ?? short.model;
    title = short.value.title || outline.title;
    body = short.value.body;
    wordCount = wordsIn(body);

    const base = artifactPath(cfg.id, 'mindmap', slug, variation, '');
    const built = await buildMindmap(outline, cfg, base);
    files.push(...built.files);
    assetPath = built.primary;
    meta.branches = outline.branches.length;
    meta.freemindImport = built.files.find((f) => f.endsWith('.mm')) ?? null;
  } else {
    // bookmarking, profile, directory, ping — short copy only.
    const { value, generator: g, model: m } = await writeShort(cfg, req, avoid);
    generator = g;
    model = m;
    title = value.title;
    body = value.body;
    wordCount = wordsIn(body);
  }

  const needsApproval =
    (cfg.approval?.requiresApproval ?? []).includes(opts.type) || generator === 'template';
  const approval = needsApproval ? 'pending' : 'not_required';

  const res = run(
    `INSERT INTO content_items
       (client_id, keyword_id, type, title, body, asset_path, anchor_text, anchor_kind,
        target_url, meta_json, approval, model, generator, word_count, variation, site_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cfg.id,
    keywordRow?.id ?? null,
    opts.type,
    title,
    body,
    assetPath ?? null,
    anchor.text,
    anchor.kind,
    anchor.targetUrl,
    JSON.stringify({ ...meta, files }),
    approval,
    model ?? null,
    generator,
    wordCount,
    variation,
    siteRow?.id ?? null,
  );

  const result: GenerateResult = {
    contentId: Number(res.lastInsertRowid),
    type: opts.type,
    keyword: keyword.keyword,
    title,
    anchorText: anchor.text,
    anchorKind: anchor.kind,
    approval,
    generator,
    wordCount,
    files,
  };

  log.info(
    `#${result.contentId} ${opts.type.padEnd(12)} ${anchor.kind.padEnd(8)} ` +
      `${String(wordCount).padStart(4)}w  ${generator}  ${title.slice(0, 54)}`,
  );
  return result;
}

/** Generates `count` assets, spreading them over the client's keywords. */
export async function generateBatch(
  cfg: ClientConfig,
  opts: GenerateOptions & { count: number },
): Promise<GenerateResult[]> {
  const out: GenerateResult[] = [];
  for (let i = 0; i < opts.count; i++) {
    out.push(await generateOne(cfg, opts));
  }
  return out;
}

/** Picks the best unused site for a type, so generation can target a platform. */
export function suggestSite(clientId: string, type: SubmissionType): string | null {
  const row = get<{ domain: string }>(
    `SELECT s.domain
       FROM sites s
      WHERE s.status IN ('vetted', 'active')
        AND s.blocklisted = 0
        AND s.categories LIKE ?
        AND NOT EXISTS (
          SELECT 1 FROM submissions sub
           WHERE sub.site_id = s.id AND sub.client_id = ?
             AND sub.created_at > datetime('now', '-7 days'))
        -- Also skip a site that already has an asset waiting to go out, or two
        -- generation runs in a row both aim at the best site and one is wasted.
        AND NOT EXISTS (
          SELECT 1 FROM content_items ci
           WHERE ci.site_id = s.id AND ci.client_id = ?
             AND ci.approval != 'rejected'
             AND NOT EXISTS (SELECT 1 FROM submissions s2 WHERE s2.content_id = ci.id))
      ORDER BY (0.45 * COALESCE(s.score, 0) + 0.55 * COALESCE(s.authority, 50)) DESC
      LIMIT 1`,
    `%"${type}"%`,
    clientId,
    clientId,
  );
  return row?.domain ?? null;
}
