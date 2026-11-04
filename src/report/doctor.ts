/**
 * Preflight checks.
 *
 * This exists because Phase 5 makes the agent unattended. An unattended run
 * that fails silently for a week is worse than no automation at all — the sheet
 * looks static, nobody investigates, and a month of link building quietly did
 * not happen. `doctor` is what you run before trusting a schedule, and what the
 * scheduled task runs first.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, get } from '../db/index.ts';
import { env, listClientIds, loadClientConfig } from '../config.ts';
import { vaultReady } from '../util/vault.ts';
import { llmAvailable } from '../content/writer.ts';
import { getSearchProvider } from '../discovery/providers.ts';
import { log } from '../util/log.ts';

export interface Check {
  name: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export function runDoctor(clientId?: string): { checks: Check[]; blocking: number } {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ── Clients ────────────────────────────────────────────────────────────────
  const ids = listClientIds();
  add({
    name: 'clients configured',
    state: ids.length ? 'ok' : 'fail',
    detail: ids.length ? ids.join(', ') : 'none',
    fix: ids.length ? undefined : 'add config/clients/<id>.json (copy _template.json)',
  });

  // ── Vault ──────────────────────────────────────────────────────────────────
  add({
    name: 'credential vault',
    state: vaultReady() ? 'ok' : 'fail',
    detail: vaultReady() ? 'VAULT_KEY present' : 'VAULT_KEY missing or malformed',
    fix: vaultReady()
      ? undefined
      : 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" → .env',
  });

  // ── LLM ────────────────────────────────────────────────────────────────────
  add({
    name: 'content LLM',
    state: llmAvailable() ? 'ok' : 'fail',
    detail: llmAvailable()
      ? `${env.llm.provider} · ${env.llm.model}`
      : 'no LLM_API_KEY — only unpublishable template text can be written',
    fix: llmAvailable() ? undefined : 'put the Groq key in .env as LLM_API_KEY',
  });

  // ── Search provider ────────────────────────────────────────────────────────
  const provider = getSearchProvider();
  add({
    name: 'search provider',
    state: provider.id === 'none' ? 'warn' : 'ok',
    detail: provider.id === 'none' ? 'none — discovery and index checks are unavailable' : provider.id,
    fix: provider.id === 'none' ? 'set SERPER_API_KEY, BRAVE_API_KEY or GOOGLE_CSE_KEY+CX' : undefined,
  });

  // ── Google Sheets ──────────────────────────────────────────────────────────
  const keyPath = resolve(PROJECT_ROOT, env.serviceAccountPath);
  const hasKey = existsSync(keyPath);
  add({
    name: 'Google service account',
    state: hasKey ? 'ok' : 'warn',
    detail: hasKey ? env.serviceAccountPath : `not found at ${env.serviceAccountPath}`,
    fix: hasKey ? undefined : 'see docs/SETUP-GOOGLE.md — sheet sync is skipped without it',
  });

  // ── Playwright ─────────────────────────────────────────────────────────────
  const hasPlaywright = existsSync(resolve(PROJECT_ROOT, 'node_modules/playwright'));
  add({
    name: 'Playwright',
    state: hasPlaywright ? 'ok' : 'fail',
    detail: hasPlaywright ? 'installed' : 'missing — browser submission and verification cannot run',
    fix: hasPlaywright ? undefined : 'npm install playwright && npx playwright install chromium',
  });

  add({
    name: 'browser mode',
    state: 'ok',
    detail: env.headless
      ? 'headless — Assist Mode cannot be completed by a human'
      : 'headful — a person can take over the window',
    fix: env.headless ? 'set HEADLESS=false in .env for unattended runs that may need help' : undefined,
  });

  // ── Operator alerts ────────────────────────────────────────────────────────
  const waReady = Boolean(process.env.OPERATOR_WHATSAPP?.trim() && process.env.TAPIFY_WA_ENDPOINT?.trim());
  add({
    name: 'operator alerts',
    state: waReady ? 'ok' : 'warn',
    detail: waReady ? process.env.OPERATOR_WHATSAPP!.trim() : 'console only — lost links will not reach your phone',
    fix: waReady ? undefined : 'set OPERATOR_WHATSAPP and TAPIFY_WA_ENDPOINT in .env',
  });

  // ── Per-client readiness ───────────────────────────────────────────────────
  for (const id of clientId ? [clientId] : ids) {
    let cfg;
    try {
      cfg = loadClientConfig(id);
    } catch (err) {
      add({
        name: `client ${id}`,
        state: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const facts = ((cfg as unknown as { content?: { facts?: string[] } }).content?.facts ?? []).length;
    add({
      name: `${id}: verified facts`,
      state: facts ? 'ok' : 'warn',
      detail: facts
        ? `${facts} fact(s) the writer may state`
        : 'empty — articles must stay general, which caps their quality',
      fix: facts ? undefined : `fill content.facts in config/clients/${id}.json from the client`,
    });

    const deepTargets = cfg.keywords.filter((k) => k.targetUrl !== cfg.siteUrl).length;
    add({
      name: `${id}: link targets`,
      state: deepTargets ? 'ok' : 'warn',
      detail: deepTargets
        ? `${deepTargets} of ${cfg.keywords.length} keywords point at a deep page`
        : 'every keyword points at the homepage',
      fix: deepTargets ? undefined : 'point each keyword at its real landing page — deep links are worth more',
    });

    const usable = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sites WHERE status IN ('vetted','active') AND blocklisted = 0",
    )?.n ?? 0;
    add({
      name: `${id}: usable platforms`,
      state: usable >= 5 ? 'ok' : usable > 0 ? 'warn' : 'fail',
      detail: `${usable} vetted`,
      fix: usable >= 5 ? undefined : 'npm run discover:seed && npm run vet',
    });

    const ready = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM content_items
        WHERE client_id = ? AND approval IN ('approved','not_required') AND generator != 'template'
          AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.content_id = content_items.id)`,
      id,
    )?.n ?? 0;
    add({
      name: `${id}: content ready to send`,
      state: ready > 0 ? 'ok' : 'warn',
      detail: `${ready} asset(s)`,
      fix: ready > 0 ? undefined : 'npm run generate -- --type bookmarking (needs LLM_API_KEY)',
    });
  }

  return { checks, blocking: checks.filter((c) => c.state === 'fail').length };
}

export function printDoctor(result: { checks: Check[]; blocking: number }) {
  log.heading('Preflight');
  for (const c of result.checks) {
    const mark = c.state === 'ok' ? 'ok  ' : c.state === 'warn' ? 'warn' : 'FAIL';
    console.log(`  ${mark}  ${c.name.padEnd(30)} ${c.detail}`);
    if (c.fix) console.log(`        → ${c.fix}`);
  }

  const warns = result.checks.filter((c) => c.state === 'warn').length;
  console.log(
    `\n  ${result.checks.filter((c) => c.state === 'ok').length} ok, ${warns} warning(s), ` +
      `${result.blocking} blocking`,
  );
  console.log(
    result.blocking
      ? '  Fix the FAILs before scheduling anything unattended.\n'
      : '  Nothing blocking. Warnings limit what the agent can do, they do not stop it.\n',
  );
}
