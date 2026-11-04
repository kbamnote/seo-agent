/**
 * Account management.
 *
 * Locked decision: the agent fills in signup forms and a human clears whatever
 * the platform throws at it. So passwords are **generated here**, never reused
 * from the client's other accounts, and stored only as vault ciphertext.
 *
 * The old tracker's passwords were `eeetechnologies@123`, `@124`, `@125` in a
 * link-shared spreadsheet. Nothing generated here is ever written to a sheet or
 * printed to a log — `reveal` exists for exactly one caller, the browser filling
 * a password field.
 */

import { randomBytes } from 'node:crypto';
import { get, run } from '../db/index.ts';
import type { ClientConfig } from '../config.ts';
import { decryptSecret, encryptSecret, vaultReady } from '../util/vault.ts';
import { log } from '../util/log.ts';

export interface AccountRow {
  id: number;
  client_id: string;
  site_id: number;
  email: string | null;
  username: string | null;
  secret_enc: string | null;
  status: string;
  notes: string | null;
}

/**
 * 20 characters of real entropy, from a set that every signup form accepts.
 * Deliberately no ambiguous glyphs, so a human reading it off a screen during
 * Assist Mode does not mistype it.
 */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%&*?';
  const bytes = randomBytes(length + 4);

  let out = '';
  for (let i = 0; i < length - 2; i++) out += alphabet[bytes[i]! % alphabet.length];
  // Guarantee one digit and one symbol: plenty of forms demand both.
  out += '23456789'[bytes[length]! % 8];
  out += symbols[bytes[length + 1]! % symbols.length];
  return out;
}

/** A username that is consistent across platforms, which is good for brand. */
export function usernameFor(cfg: ClientConfig, siteDomain: string): string {
  const preferred = cfg.contact?.preferredUsername?.trim();
  if (preferred) return preferred;
  return cfg.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

export function findAccount(clientId: string, siteId: number): AccountRow | undefined {
  return get<AccountRow>(
    `SELECT id, client_id, site_id, email, username, secret_enc, status, notes
       FROM accounts WHERE client_id = ? AND site_id = ? ORDER BY id LIMIT 1`,
    clientId,
    siteId,
  );
}

export interface EnsureResult {
  account: AccountRow;
  created: boolean;
  /** Present only when this call generated it, so a signup can type it. */
  password?: string;
}

/**
 * Returns the account for this client and site, creating the record (and a
 * password) if there is none. Creating the *record* is not creating the account
 * on the platform — that is the adapter's signup step, which may need a human.
 */
export function ensureAccount(cfg: ClientConfig, siteId: number, siteDomain: string): EnsureResult {
  const existing = findAccount(cfg.id, siteId);
  if (existing) {
    if (!existing.secret_enc && vaultReady()) {
      // Imported from the old tracker without a usable password: give it one.
      const password = generatePassword();
      run('UPDATE accounts SET secret_enc = ? WHERE id = ?', encryptSecret(password), existing.id);
      log.info(`${siteDomain}: generated a new password for ${existing.username} (old one was not stored)`);
      return { account: { ...existing, secret_enc: 'set' }, created: false, password };
    }
    return { account: existing, created: false };
  }

  if (!vaultReady()) {
    throw new Error('VAULT_KEY is not set, so a password cannot be stored. See .env.example.');
  }

  const password = generatePassword();
  const username = usernameFor(cfg, siteDomain);
  const res = run(
    `INSERT INTO accounts (client_id, site_id, email, username, secret_enc, status, notes)
     VALUES (?, ?, ?, ?, ?, 'unverified', 'created by agent')`,
    cfg.id,
    siteId,
    cfg.contact?.email ?? null,
    username,
    encryptSecret(password),
  );

  const account = findAccount(cfg.id, siteId)!;
  log.info(`${siteDomain}: account record created for ${username} (#${Number(res.lastInsertRowid)})`);
  return { account, created: true, password };
}

/**
 * Decrypts the stored password. The only legitimate caller is a browser about
 * to type it into the platform's own login form. It is never logged, never
 * returned to the CLI, and never written to the sheet.
 */
export function reveal(account: AccountRow): string {
  if (!account.secret_enc || account.secret_enc === 'set') {
    throw new Error(`No stored password for account #${account.id}. Re-run signup, or add it by hand.`);
  }
  return decryptSecret(account.secret_enc);
}

export function markAccount(id: number, status: string, note?: string): void {
  run(
    `UPDATE accounts SET status = ?, notes = COALESCE(?, notes),
       verified_at = CASE WHEN ? = 'active' THEN datetime('now') ELSE verified_at END,
       last_login_at = CASE WHEN ? IN ('active') THEN datetime('now') ELSE last_login_at END
     WHERE id = ?`,
    status,
    note ?? null,
    status,
    status,
    id,
  );
}
