/**
 * Credential vault.
 *
 * Site passwords live in SQLite as AES-256-GCM ciphertext keyed by VAULT_KEY
 * from .env. The point is that no plaintext password ever reaches a file that
 * gets shared, synced or committed — which is exactly how the current tracker
 * leaked every account it holds.
 *
 * Format: v1:<iv-hex>:<tag-hex>:<ciphertext-hex>
 *   - iv is 12 random bytes per secret (GCM's required nonce size)
 *   - tag is the 16-byte auth tag, so tampering fails loudly rather than
 *     decrypting to garbage
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'v1';

function key(): Buffer {
  const hex = process.env.VAULT_KEY?.trim();
  if (!hex) {
    throw new Error(
      'VAULT_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'then put it in .env. Keep a backup: without it, stored passwords are gone.',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`VAULT_KEY must be 64 hex characters (32 bytes); got ${hex.length}.`);
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Stored secret is not in v1 vault format.');
  }
  const [, ivHex, tagHex, dataHex] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** True when the value looks like it came out of this vault. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

export function vaultReady(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Password hygiene check, run at import time so the audit can report on the
 * existing accounts without ever writing the password anywhere. Returns problem
 * codes only — never the password itself.
 */
export function passwordProblems(password: string, username?: string | null): string[] {
  const problems: string[] = [];
  const pw = password.trim();
  if (!pw) return ['empty'];

  if (username && pw.toLowerCase() === username.trim().toLowerCase()) {
    problems.push('equals_username');
  }
  if (pw.length < 12) problems.push('short');
  if (/^[^0-9]*\d{1,4}$/.test(pw)) problems.push('trailing_counter');
  if (/(123|1234|abcd|qwerty|password|admin)/i.test(pw)) problems.push('common_pattern');

  // A password that simply repeats the brand is guessable from the sheet alone.
  const alpha = pw.replace(/[^a-z]/gi, '').toLowerCase();
  if (username) {
    const user = username.replace(/[^a-z]/gi, '').toLowerCase();
    if (user.length > 4 && alpha.includes(user.slice(0, Math.min(user.length, 12)))) {
      problems.push('contains_username');
    }
  }
  return problems;
}

/** Constant-time compare, for anywhere we check a secret rather than store it. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
