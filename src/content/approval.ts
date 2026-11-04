/**
 * The approval queue.
 *
 * Locked decision: blog articles wait for a human, everything else goes
 * automatically. Template-generated copy also waits, whatever its type.
 *
 * Approving is a positive act and nothing else sets `approved` — so if the
 * queue is ignored, the worst case is that nothing gets published, not that
 * something embarrassing does.
 */

import { readFileSync } from 'node:fs';
import { all, get, run } from '../db/index.ts';
import { log } from '../util/log.ts';

export interface PendingRow {
  id: number;
  type: string;
  title: string;
  keyword: string | null;
  anchor_text: string | null;
  anchor_kind: string | null;
  generator: string | null;
  word_count: number | null;
  asset_path: string | null;
  created_at: string;
}

export function listPending(clientId: string, limit = 50): PendingRow[] {
  return all<PendingRow>(
    `SELECT c.id, c.type, c.title, k.keyword, c.anchor_text, c.anchor_kind,
            c.generator, c.word_count, c.asset_path, c.created_at
       FROM content_items c
       LEFT JOIN keywords k ON k.id = c.keyword_id
      WHERE c.client_id = ? AND c.approval = 'pending'
      ORDER BY c.id
      LIMIT ?`,
    clientId,
    limit,
  );
}

export function printPending(rows: PendingRow[]) {
  if (!rows.length) {
    console.log('Nothing waiting for approval.');
    return;
  }
  log.heading(`${rows.length} awaiting approval`);
  for (const r of rows) {
    console.log(
      `  #${String(r.id).padEnd(4)} ${r.type.padEnd(12)} ${(r.generator ?? '').padEnd(9)}` +
        `${String(r.word_count ?? '').padStart(5)}w  ${r.anchor_kind ?? ''}`,
    );
    console.log(`        ${r.title}`);
    if (r.asset_path) console.log(`        ${r.asset_path}`);
  }
  console.log(`\n  review one:  npm run content -- show <id>`);
  console.log(`  approve:     npm run content -- approve <id>\n`);
}

export function showContent(id: number) {
  const row = get<{
    id: number;
    client_id: string;
    type: string;
    title: string;
    body: string;
    asset_path: string | null;
    anchor_text: string;
    anchor_kind: string;
    target_url: string;
    approval: string;
    generator: string | null;
    model: string | null;
    word_count: number | null;
    variation: number;
    meta_json: string | null;
    keyword: string | null;
  }>(
    `SELECT c.*, k.keyword FROM content_items c
       LEFT JOIN keywords k ON k.id = c.keyword_id
      WHERE c.id = ?`,
    id,
  );
  if (!row) {
    console.log(`No content item #${id}.`);
    return;
  }

  log.heading(`#${row.id} — ${row.type}`);
  console.log(`  title ........... ${row.title}`);
  console.log(`  keyword ......... ${row.keyword ?? '-'}`);
  console.log(`  anchor .......... "${row.anchor_text}" (${row.anchor_kind}) → ${row.target_url}`);
  console.log(`  approval ........ ${row.approval}`);
  console.log(`  written by ...... ${row.generator}${row.model ? ` (${row.model})` : ''}`);
  console.log(`  words ........... ${row.word_count ?? '-'}`);
  console.log(`  variation ....... ${row.variation}`);
  if (row.asset_path) console.log(`  file ............ ${row.asset_path}`);

  const meta = row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : {};
  if (meta.site) console.log(`  for platform .... ${meta.site}`);
  if (Array.isArray(meta.files) && meta.files.length > 1) {
    console.log('  also wrote:');
    for (const f of meta.files.slice(1)) console.log(`    ${f}`);
  }

  console.log('\n  ── body ──────────────────────────────────────────────────────────\n');
  // For a file-backed asset the body is the platform's description field; for a
  // blog post the markdown file is the thing to read.
  const text =
    row.type === 'blog' && row.asset_path
      ? safeRead(row.asset_path) ?? row.body
      : row.body;
  console.log(
    text
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  console.log('');
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function setApproval(id: number, approval: 'approved' | 'rejected', note?: string) {
  const row = get<{ generator: string | null; approval: string }>(
    'SELECT generator, approval FROM content_items WHERE id = ?',
    id,
  );
  if (!row) throw new Error(`No content item #${id}.`);

  if (approval === 'approved' && row.generator === 'template') {
    throw new Error(
      `#${id} is template output — structural placeholder text, not publishable.\n` +
        'Set LLM_API_KEY and regenerate it rather than approving this.',
    );
  }

  run('UPDATE content_items SET approval = ? WHERE id = ?', approval, id);
  log.info(`#${id} → ${approval}${note ? ` (${note})` : ''}`);
}

/** What the submission engine is allowed to send. */
export function isSendable(id: number): { ok: boolean; why?: string } {
  const row = get<{ approval: string; generator: string | null }>(
    'SELECT approval, generator FROM content_items WHERE id = ?',
    id,
  );
  if (!row) return { ok: false, why: 'no such content item' };
  if (row.generator === 'template') return { ok: false, why: 'template output is never publishable' };
  if (row.approval === 'pending') return { ok: false, why: 'awaiting approval' };
  if (row.approval === 'rejected') return { ok: false, why: 'rejected' };
  return { ok: true };
}
