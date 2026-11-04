/**
 * The agent's own Google Sheet.
 *
 * Locked decision: the agent does not write into the team's manual tracker. It
 * owns a separate sheet with the same ten columns plus the verification columns
 * the manual process never had, so a row can still be copied across by hand but
 * "Approved" here means a verifier actually found the link.
 *
 * Each push rewrites the tab in full. That is safe precisely because nobody
 * edits this sheet by hand — and it keeps the sheet a true mirror of the
 * database rather than an append-only log that drifts.
 */

import { all, get, run } from '../db/index.ts';
import { TYPE_TO_SHEET_TAB, env, type SubmissionType } from '../config.ts';
import { log } from '../util/log.ts';
import { AGENT_COLUMNS } from './schema.ts';
import { driveApi, explainSheetError, sheetsApi } from './auth.ts';

const TAB_ORDER: SubmissionType[] = [
  'blog',
  'profile',
  'directory',
  'bookmarking',
  'pdf',
  'ppt',
  'image',
  'mindmap',
  'ping',
];

const STATUS_LABEL: Record<string, string> = {
  verified: 'Approved (verified live)',
  submitted: 'Submitted (not yet verified)',
  unverifiable: 'No URL recorded',
  awaiting_approval: 'Awaiting your approval',
  manual_queue: 'Needs manual posting',
  queued: 'Queued',
  generated: 'Content ready',
  submitting: 'In progress',
  failed: 'Failed',
  lost: 'Lost (link gone)',
};

export async function createAgentSheet(clientId: string, clientName: string): Promise<string> {
  const api = sheetsApi();

  const created = await api.spreadsheets.create({
    requestBody: {
      properties: { title: `${clientName} — Off Page (agent)` },
      sheets: [
        ...TAB_ORDER.map((t) => ({ properties: { title: TYPE_TO_SHEET_TAB[t] } })),
        { properties: { title: 'Findings' } },
      ],
    },
    fields: 'spreadsheetId,spreadsheetUrl',
  });

  const sheetId = created.data.spreadsheetId;
  if (!sheetId) throw new Error('Google created a spreadsheet but returned no id.');

  // Header row on every tab, frozen so it stays visible.
  const meta = await api.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets.properties(sheetId,title)',
  });

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: (meta.data.sheets ?? []).map((s) => ({
        range: `'${s.properties!.title}'!A1`,
        values: [
          s.properties!.title === 'Findings'
            ? ['Severity', 'Code', 'Message', 'Tab', 'Row', 'Detected']
            : [...AGENT_COLUMNS],
        ],
      })),
    },
  });

  await api.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: (meta.data.sheets ?? []).flatMap((s) => [
        {
          updateSheetProperties: {
            properties: {
              sheetId: s.properties!.sheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          repeatCell: {
            range: { sheetId: s.properties!.sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ]),
    },
  });

  // A service account's Drive is invisible to you; without this share, the
  // sheet exists and you cannot open it.
  const shareWith = env.shareWith;
  if (shareWith) {
    await driveApi().permissions.create({
      fileId: sheetId,
      sendNotificationEmail: false,
      requestBody: { type: 'user', role: 'writer', emailAddress: shareWith },
    });
    log.info(`shared with ${shareWith}`);
  } else {
    log.warn('SHEET_SHARE_WITH is empty — the sheet exists but is not shared with you yet.');
  }

  run("UPDATE clients SET agent_sheet_id = ?, updated_at = datetime('now') WHERE id = ?", sheetId, clientId);

  log.info(`agent sheet created: ${created.data.spreadsheetUrl}`);
  return sheetId;
}

interface PushRow {
  id: number;
  type: SubmissionType;
  platform_url: string | null;
  submitted_url: string | null;
  keyword_text: string | null;
  status: string;
  operator: string | null;
  submitted_at: string | null;
  email: string | null;
  username: string | null;
  has_secret: number;
  anchor_text: string | null;
  anchor_kind: string | null;
  link_present: number | null;
  rel: string | null;
  indexed: number | null;
  checked_at: string | null;
}

export async function pushClient(clientId: string): Promise<{ sheetId: string; rows: number }> {
  const client = get<{ agent_sheet_id: string | null; name: string }>(
    'SELECT agent_sheet_id, name FROM clients WHERE id = ?',
    clientId,
  );
  if (!client) throw new Error(`Unknown client "${clientId}".`);

  const sheetId = client.agent_sheet_id || env.agentSheetId;
  if (!sheetId) {
    throw new Error(
      `No agent sheet for "${clientId}". Create one with:\n  npm run sheet:create -- --client ${clientId}`,
    );
  }

  const rows = all<PushRow>(
    `SELECT s.id, s.type, s.platform_url, s.submitted_url, s.keyword_text, s.status,
            s.operator, s.submitted_at,
            a.email, a.username,
            CASE WHEN a.secret_enc IS NOT NULL THEN 1 ELSE 0 END AS has_secret,
            c.anchor_text, c.anchor_kind,
            v.link_present, v.rel, v.indexed, v.checked_at
       FROM submissions s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN content_items c ON c.id = s.content_id
       LEFT JOIN verifications v ON v.id = (
            SELECT id FROM verifications
             WHERE submission_id = s.id
             ORDER BY checked_at DESC, id DESC LIMIT 1)
      WHERE s.client_id = ?
      ORDER BY s.type, s.submitted_at, s.id`,
    clientId,
  );

  const api = sheetsApi();
  const data: Array<{ range: string; values: unknown[][] }> = [];

  for (const type of TAB_ORDER) {
    const tab = TYPE_TO_SHEET_TAB[type];
    const subset = rows.filter((r) => r.type === type);
    const values = subset.map((r, i) => [
      i + 1,
      r.platform_url ?? '',
      r.submitted_url ?? '',
      r.email ?? '',
      r.username ?? '',
      // Never the password. The sheet is the leak the vault exists to stop.
      r.has_secret ? 'in vault' : '',
      r.submitted_at ?? '',
      STATUS_LABEL[r.status] ?? r.status,
      r.operator ?? 'seo-agent',
      r.keyword_text ?? '',
      r.anchor_text ?? '',
      r.anchor_kind ?? '',
      r.link_present === null ? '' : r.link_present ? 'yes' : 'no',
      r.rel ?? '',
      r.indexed === null ? '' : r.indexed ? 'yes' : 'no',
      r.checked_at ?? '',
      '',
    ]);
    data.push({ range: `'${tab}'!A2`, values });
  }

  const findings = all<{ severity: string; code: string; message: string; detail: string | null; created_at: string }>(
    'SELECT severity, code, message, detail, created_at FROM findings WHERE client_id = ? ORDER BY severity, code',
    clientId,
  );
  data.push({
    range: "'Findings'!A2",
    values: findings.map((f) => {
      let tab = '';
      let row = '';
      try {
        const d = f.detail ? JSON.parse(f.detail) : {};
        tab = d.tab ?? '';
        row = d.row ?? '';
      } catch {
        /* detail is advisory only */
      }
      return [f.severity, f.code, f.message, tab, row, f.created_at];
    }),
  });

  try {
    // Clear first so deleted rows do not linger below the new data.
    await api.spreadsheets.values.batchClear({
      spreadsheetId: sheetId,
      requestBody: { ranges: data.map((d) => d.range.replace('!A2', '!A2:Q')) },
    });
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: data.filter((d) => d.values.length > 0),
      },
    });
  } catch (err) {
    throw new Error(explainSheetError(err, sheetId));
  }

  log.info(`pushed ${rows.length} rows + ${findings.length} findings → ${sheetId}`);
  return { sheetId, rows: rows.length };
}
