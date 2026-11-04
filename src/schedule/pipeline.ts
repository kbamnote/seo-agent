/**
 * The scheduled pipelines — the two commands a task scheduler calls.
 *
 * **daily**: top up content, submit what is ready, verify what was sent, refresh
 * the sheet and the dashboard.
 * **weekly**: re-verify the whole history and alert on anything that died.
 *
 * Two design rules, both learned from the tracker this replaces:
 *
 *   1. **A failing step does not abort the run.** If generation fails because an
 *      LLM quota ran out, verification of yesterday's links should still happen —
 *      that is the step that protects the client's existing asset. Each step is
 *      isolated and its failure recorded.
 *   2. **Nothing publishes itself past the quota.** The runner owns pacing and
 *      caps; this module never bypasses them, so a scheduler misfiring twice in
 *      an hour cannot double the day's output.
 */

import type { ClientConfig, SubmissionType } from '../config.ts';
import { listClientIds, loadClientConfig } from '../config.ts';
import { startRun } from '../db/index.ts';
import { log } from '../util/log.ts';
import { generateOne, suggestSite } from '../content/index.ts';
import { llmAvailable } from '../content/writer.ts';
import { quotaReport, runBatch } from '../submit/runner.ts';
import { exportManualQueue } from '../submit/manual.ts';
import { runVerification } from '../verify/index.ts';
import { buildLinkReport } from '../report/links.ts';
import { writeDashboard } from '../report/dashboard.ts';
import { pushClient } from '../sheets/agentSheet.ts';
import { assistAlert, dispatch, failureAlert, lostSinceAlert, type Alert } from '../notify/alert.ts';

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

export interface PipelineResult {
  clientId: string;
  steps: StepResult[];
  alerts: number;
}

interface StepOptions {
  dryRun?: boolean;
  skip?: string[];
}

async function step(
  results: StepResult[],
  name: string,
  opts: StepOptions,
  fn: () => Promise<string> | string,
): Promise<void> {
  if (opts.skip?.includes(name)) {
    results.push({ step: name, ok: true, detail: 'skipped' });
    return;
  }
  log.heading(name);
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`${name} failed: ${detail}`);
    results.push({ step: name, ok: false, detail });
  }
}

/**
 * How many assets to keep in reserve per type: enough that tomorrow's
 * submission run has something to send without generating on the critical path.
 */
function topUpPlan(cfg: ClientConfig): Array<{ type: SubmissionType; count: number }> {
  const perType = (cfg.quotas?.perDayPerType ?? {}) as Record<string, number>;
  return Object.entries(perType)
    .filter(([, n]) => Number(n) > 0)
    .map(([type, n]) => ({ type: type as SubmissionType, count: Math.max(1, Math.ceil(Number(n) / 2)) }));
}

export async function runDaily(cfg: ClientConfig, opts: StepOptions = {}): Promise<PipelineResult> {
  const results: StepResult[] = [];
  const tracked = startRun('daily', cfg.id);

  await step(results, 'generate', opts, async () => {
    if (!llmAvailable()) {
      // Template output cannot be submitted, so generating it on a schedule
      // would only fill the approval queue with noise.
      return 'skipped: no LLM_API_KEY, so only unpublishable template text could be written';
    }
    if (opts.dryRun) return `would top up: ${topUpPlan(cfg).map((p) => `${p.type}x${p.count}`).join(', ')}`;

    let written = 0;
    for (const plan of topUpPlan(cfg)) {
      for (let i = 0; i < plan.count; i++) {
        const site = suggestSite(cfg.id, plan.type);
        if (!site) break; // no vetted platform left for this type today
        try {
          await generateOne(cfg, { type: plan.type, siteDomain: site });
          written++;
        } catch (err) {
          log.warn(`generate ${plan.type} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    return `${written} asset(s) written`;
  });

  await step(results, 'submit', opts, async () => {
    const stats = await runBatch(cfg, { limit: 10, dryRun: opts.dryRun });
    return opts.dryRun
      ? 'dry run — nothing sent'
      : `${stats.submitted} submitted, ${stats.needsAssist} need a human, ${stats.failed} failed`;
  });

  await step(results, 'manual queue', opts, () => {
    if (opts.dryRun) return 'dry run';
    const out = exportManualQueue(cfg, 20);
    return out.items ? `${out.items} item(s) → ${out.path}` : 'nothing for a human';
  });

  await step(results, 'verify', opts, async () => {
    if (opts.dryRun) return 'dry run';
    const stats = await runVerification(cfg, { limit: 20, concurrency: 3 });
    return `${stats.verified} live, ${stats.lost} lost, ${stats.waiting} waiting, ${stats.inconclusive} unknown`;
  });

  await step(results, 'sheet', opts, async () => {
    if (opts.dryRun) return 'dry run';
    const out = await pushClient(cfg.id);
    return `${out.rows} row(s) pushed`;
  });

  await step(results, 'report', opts, () => {
    if (opts.dryRun) return 'dry run';
    const report = buildLinkReport(cfg.id);
    const dash = writeDashboard(cfg);
    return `${report.totals.verified} verified live · ${dash}`;
  });

  const alerts: Alert[] = [];
  const lost = lostSinceAlert(cfg.id, 36);
  if (lost) alerts.push(lost);
  const assist = assistAlert(cfg.id);
  if (assist) alerts.push(assist);
  for (const failed of results.filter((r) => !r.ok)) {
    alerts.push(failureAlert(cfg.id, failed.step, failed.detail));
  }
  if (!opts.dryRun) await dispatch(cfg.id, alerts);

  tracked.finish({ steps: results, alerts: alerts.length });
  return { clientId: cfg.id, steps: results, alerts: alerts.length };
}

export async function runWeekly(cfg: ClientConfig, opts: StepOptions = {}): Promise<PipelineResult> {
  const results: StepResult[] = [];
  const tracked = startRun('weekly', cfg.id);

  await step(results, 'resweep', opts, async () => {
    if (opts.dryRun) return 'dry run';
    // The whole history, including links previously given up on: platforms do
    // restore content, and a link that came back is worth knowing about.
    const stats = await runVerification(cfg, {
      limit: 200,
      concurrency: 3,
      resweep: true,
      checkIndex: false,
    });
    return `${stats.checked} checked · ${stats.verified} live · ${stats.lost} lost · ${stats.inconclusive} unknown`;
  });

  await step(results, 'report', opts, () => {
    if (opts.dryRun) return 'dry run';
    const report = buildLinkReport(cfg.id);
    const dash = writeDashboard(cfg);
    return `${report.totals.verified} verified live · ${dash}`;
  });

  const alerts: Alert[] = [];
  const lost = lostSinceAlert(cfg.id, 24 * 8);
  if (lost) alerts.push(lost);
  for (const failed of results.filter((r) => !r.ok)) {
    alerts.push(failureAlert(cfg.id, failed.step, failed.detail));
  }
  if (!opts.dryRun) await dispatch(cfg.id, alerts);

  tracked.finish({ steps: results, alerts: alerts.length });
  return { clientId: cfg.id, steps: results, alerts: alerts.length };
}

/** Every configured client, one after another. */
export async function runForAll(
  which: 'daily' | 'weekly',
  opts: StepOptions = {},
): Promise<PipelineResult[]> {
  const ids = listClientIds();
  if (!ids.length) throw new Error('No clients configured in config/clients/.');

  const out: PipelineResult[] = [];
  for (const id of ids) {
    const cfg = loadClientConfig(id);
    log.heading(`${which} — ${cfg.name} (${id})`);
    out.push(which === 'daily' ? await runDaily(cfg, opts) : await runWeekly(cfg, opts));
  }
  return out;
}

export function printPipeline(result: PipelineResult) {
  const q = (() => {
    try {
      return quotaReport(loadClientConfig(result.clientId));
    } catch {
      return null;
    }
  })();

  log.heading(`Done — ${result.clientId}`);
  for (const s of result.steps) {
    console.log(`  ${s.ok ? 'ok  ' : 'FAIL'}  ${s.step.padEnd(14)} ${s.detail}`);
  }
  if (q) console.log(`\n  quota today: ${q.totalUsed} used, ${q.totalLeft} left`);
  if (result.alerts) console.log(`  alerts raised: ${result.alerts}`);
  console.log('');
}
