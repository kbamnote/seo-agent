/**
 * Google API auth via a service account.
 *
 * Why a service account and not OAuth: the agent runs unattended on a cron. A
 * refresh token tied to a human account expires and needs a browser; a service
 * account does not.
 *
 * Consequence to remember: the service account has its own Drive that you
 * cannot see. Any sheet it creates is invisible until it is shared with you,
 * which is what SHEET_SHARE_WITH is for.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { google } from 'googleapis';
import type { sheets_v4, drive_v3 } from 'googleapis';
import { PROJECT_ROOT } from '../db/index.ts';
import { env } from '../config.ts';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  // drive.file is enough: it covers files this service account creates, which
  // is all the agent needs. The broad drive scope is not requested.
  'https://www.googleapis.com/auth/drive.file',
];

let sheetsClient: sheets_v4.Sheets | null = null;
let driveClient: drive_v3.Drive | null = null;

function authClient() {
  const keyFile = resolve(PROJECT_ROOT, env.serviceAccountPath);
  if (!existsSync(keyFile)) {
    throw new Error(
      `Service-account key not found at ${keyFile}.\n` +
        'See docs/SETUP-GOOGLE.md — it takes about five minutes in Google Cloud Console.\n' +
        'Then set GOOGLE_SERVICE_ACCOUNT_JSON in .env.',
    );
  }
  return new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
}

export function sheetsApi(): sheets_v4.Sheets {
  if (!sheetsClient) sheetsClient = google.sheets({ version: 'v4', auth: authClient() });
  return sheetsClient;
}

export function driveApi(): drive_v3.Drive {
  if (!driveClient) driveClient = google.drive({ version: 'v3', auth: authClient() });
  return driveClient;
}

/**
 * Turns the Google client's unhelpful 403/404 into something actionable — the
 * usual cause is simply that nobody shared the sheet with the service account.
 */
export function explainSheetError(err: unknown, sheetId: string, saEmail?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/permission|forbidden|403/i.test(message)) {
    return (
      `Google refused access to sheet ${sheetId}.\n` +
      `Open the sheet, press Share, and add the service-account email` +
      (saEmail ? ` (${saEmail})` : ' (the client_email in your key file)') +
      ' as Viewer for the source sheet, Editor for the agent sheet.'
    );
  }
  if (/not found|404/i.test(message)) {
    return `Sheet ${sheetId} does not exist, or the service account cannot see it. Check the ID in .env.`;
  }
  return message;
}
