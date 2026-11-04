/**
 * The manual queue.
 *
 * Reddit, Quora, Medium, dev.to, Justdial and the phone-verified directories
 * forbid automated posting or cannot be automated at all. Pretending otherwise
 * gets accounts banned, so the agent does the part it can — write the thing,
 * pick the anchor, choose the platform — and hands over a brief a human can
 * action in about a minute.
 *
 * The handover is recorded as a submission with status `manual_queue`, so these
 * links are tracked and verified exactly like the automated ones. Work that
 * leaves the system untracked is how the old spreadsheet ended up with rows
 * nobody could prove.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, get, run } from '../db/index.ts';
import type { ClientConfig } from '../config.ts';
import { todayIso } from '../util/dates.ts';
import { log } from '../util/log.ts';
import { isSendable } from '../content/approval.ts';
import { pickManual, type WorkItem } from './runner.ts';

const PLATFORM_NOTES: Record<string, string> = {
  'reddit.com':
    'Post in a subreddit where the topic genuinely fits and where you have comment history. ' +
    'A first post from a fresh account reads as spam and gets removed. Links are nofollow: ' +
    'this is for traffic and brand, not authority.',
  'quora.com':
    'Answer an existing question properly. The link belongs in the body only if it is the ' +
    'natural citation for a claim you are making.',
  'medium.com':
    'Publish under the brand account. External links are nofollow, so the value here is reach.',
  'dev.to':
    'Only post genuine technical writing. Moderators remove thin promotional posts quickly.',
  'justdial.com':
    'Phone-verified listing. Do this once, then keep the name, address and phone identical to ' +
    'every other citation — consistency is the whole point of a directory listing.',
  'sulekha.com': 'Phone-verified. Same consistency rule as Justdial.',
  'indiamart.com': 'Phone-verified. Same consistency rule.',
  'tradeindia.com': 'Phone-verified. Same consistency rule.',
};

export interface ManualExport {
  path: string;
  items: number;
}

export function exportManualQueue(cfg: ClientConfig, limit = 20): ManualExport {
  // Same gate as the automated path. Handing a human a brief full of template
  // placeholder text wastes their time and risks it being posted anyway.
  const items = pickManual(cfg, limit).filter((item) => {
    const sendable = isSendable(item.contentId);
    if (!sendable.ok) log.debug(`#${item.contentId} not queued: ${sendable.why}`);
    return sendable.ok;
  });
  const dir = resolve(PROJECT_ROOT, 'data/reports');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${cfg.id}-manual-queue-${todayIso()}.md`);

  const lines: string[] = [
    `# Manual submission queue — ${cfg.name}`,
    '',
    `${items.length} item${items.length === 1 ? '' : 's'}, generated ${todayIso()}.`,
    '',
    'These platforms forbid automated posting or need phone/email verification, so a person',
    'posts them. Everything below is already written and checked; the work is copy, paste, post,',
    'then record the URL.',
    '',
    '**After posting, record the URL so it gets verified like everything else:**',
    '',
    '```bash',
    'npm run cli -- submit record <id> <url>',
    '```',
    '',
    '---',
    '',
  ];

  for (const item of items) {
    const submissionId = recordManual(cfg, item);
    const note = PLATFORM_NOTES[item.siteDomain];

    lines.push(`## ${item.siteDomain} — ${item.type}`);
    lines.push('');
    lines.push(`- **Record with id:** \`${submissionId}\``);
    lines.push(`- **Keyword:** ${item.keywordText ?? '-'}`);
    lines.push(`- **Link to place:** ${item.targetUrl}`);
    lines.push(`- **Anchor text:** ${item.anchorText}`);
    if (item.assetPath) lines.push(`- **File to upload:** ${item.assetPath}`);
    if (note) lines.push(`- **Platform note:** ${note}`);
    lines.push('');
    lines.push(`**Title**`);
    lines.push('');
    lines.push('```');
    lines.push(item.title);
    lines.push('```');
    lines.push('');
    lines.push(`**Body**`);
    lines.push('');
    lines.push('```');
    lines.push(item.body);
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (!items.length) {
    lines.push('_Nothing queued. Generate content for a manual-only platform first:_');
    lines.push('');
    lines.push('```bash');
    lines.push('npm run generate -- --type profile --site reddit.com');
    lines.push('```');
  }

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  log.info(`manual queue → ${path} (${items.length} item${items.length === 1 ? '' : 's'})`);
  return { path, items: items.length };
}

function recordManual(cfg: ClientConfig, item: WorkItem): number {
  const existing = get<{ id: number; status: string }>(
    `SELECT id, status FROM submissions WHERE content_id = ? AND client_id = ?`,
    item.contentId,
    cfg.id,
  );
  if (existing) {
    // Content that failed an automated attempt and is now being handed to a
    // person becomes manual_queue. Leaving it `failed` meant the brief listed a
    // record id whose row said something else, so the item disappeared from
    // every manual-queue view while still appearing in the exported file.
    if (existing.status === 'failed') {
      run(
        `UPDATE submissions SET status = 'manual_queue', operator = 'human',
           last_error = NULL, updated_at = datetime('now')
         WHERE id = ?`,
        existing.id,
      );
    }
    return existing.id;
  }

  const res = run(
    `INSERT INTO submissions
       (client_id, site_id, keyword_id, content_id, type, platform_url, keyword_text,
        status, operator, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_queue', 'human', 'agent')`,
    cfg.id,
    item.siteId,
    item.keywordId,
    item.contentId,
    item.type,
    `https://${item.siteDomain}/`,
    item.keywordText,
  );
  return Number(res.lastInsertRowid);
}

/** Records the URL a human posted, so the verifier picks it up. */
export function recordManualResult(submissionId: number, url: string, operator?: string): void {
  const row = get<{ id: number; status: string }>(
    'SELECT id, status FROM submissions WHERE id = ?',
    submissionId,
  );
  if (!row) throw new Error(`No submission #${submissionId}.`);
  if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" is not a URL.`);

  run(
    `UPDATE submissions SET
       submitted_url = ?, status = 'submitted', operator = COALESCE(?, operator),
       submitted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    url,
    operator ?? null,
    submissionId,
  );
  log.info(`#${submissionId} recorded → ${url} (status: submitted, awaiting verification)`);
}
