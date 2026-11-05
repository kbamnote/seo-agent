/**
 * The scheduler, run inside the web process.
 *
 * The obvious arrangement on Railway is a second service with a cron schedule.
 * It does not work: **a Railway volume attaches to one service only**, so the
 * cron service gets its own empty database. It writes content the panel never
 * sees, and reports "Unknown client" for clients the panel shows — which is
 * exactly what happened, and the failure is quiet enough to go unnoticed for
 * days because every step reports "ok".
 *
 * So the schedule lives in the same process as the web UI: one service, one
 * volume, one database. The cost is that a run and the UI share a process; for
 * a single-operator admin tool that is a fair trade against silently split
 * state.
 *
 * Times are UTC, as `HH:MM`. Unset means no automatic runs, which is the right
 * default for a laptop.
 */

import { listClientIds, loadClientConfig } from '../config.ts';
import { runDaily, runWeekly } from './pipeline.ts';
import { log } from '../util/log.ts';

const CHECK_EVERY_MS = 60_000;

/** Which weekday the weekly run uses: 0 is Sunday. */
const WEEKLY_DAY = Number(process.env.WEEKLY_DAY ?? 0);

interface Slot {
  name: 'daily' | 'weekly';
  at: string;
  /** yyyy-mm-dd of the last run, so a restart cannot run it twice. */
  lastRun: string | null;
  run: () => Promise<void>;
}

function parseTime(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    log.warn(`"${value}" is not a time like 05:00 — that schedule is off`);
    return null;
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) {
    log.warn(`"${value}" is not a valid time — that schedule is off`);
    return null;
  }
  return `${String(h).padStart(2, '0')}:${match[2]}`;
}

async function forEachClient(which: 'daily' | 'weekly'): Promise<void> {
  const ids = listClientIds();
  if (!ids.length) {
    log.warn(`${which}: no clients configured, nothing to do`);
    return;
  }

  for (const id of ids) {
    try {
      const cfg = loadClientConfig(id);
      log.heading(`${which} — ${cfg.name} (${id})`);
      const result = which === 'daily' ? await runDaily(cfg) : await runWeekly(cfg);
      const failed = result.steps.filter((s) => !s.ok);
      log.info(
        `${which} finished for ${id}: ${result.steps.length - failed.length}/${result.steps.length} steps ok` +
          (failed.length ? `, failed: ${failed.map((f) => f.step).join(', ')}` : ''),
      );
    } catch (err) {
      // One client's failure must not stop the others.
      log.error(`${which} failed for ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export function startScheduler(): { daily: string | null; weekly: string | null } {
  const dailyAt = parseTime(process.env.DAILY_AT);
  const weeklyAt = parseTime(process.env.WEEKLY_AT);

  if (!dailyAt && !weeklyAt) {
    log.info('no schedule set (DAILY_AT / WEEKLY_AT); runs are manual');
    return { daily: null, weekly: null };
  }

  const slots: Slot[] = [];
  if (dailyAt) {
    slots.push({ name: 'daily', at: dailyAt, lastRun: null, run: () => forEachClient('daily') });
  }
  if (weeklyAt) {
    slots.push({ name: 'weekly', at: weeklyAt, lastRun: null, run: () => forEachClient('weekly') });
  }

  let busy = false;

  const tick = async () => {
    // A run can take longer than the interval; never start a second one.
    if (busy) return;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    for (const slot of slots) {
      if (slot.at !== hhmm) continue;
      if (slot.lastRun === today) continue;
      if (slot.name === 'weekly' && now.getUTCDay() !== WEEKLY_DAY) continue;

      slot.lastRun = today;
      busy = true;
      log.info(`${slot.name} run starting (${hhmm} UTC)`);
      try {
        await slot.run();
      } catch (err) {
        log.error(`${slot.name} run failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        busy = false;
      }
    }
  };

  const timer = setInterval(() => void tick(), CHECK_EVERY_MS);
  // Never hold the process open on its own account.
  timer.unref?.();

  log.info(
    `scheduled: ${dailyAt ? `daily at ${dailyAt} UTC` : 'no daily'}` +
      `${weeklyAt ? `, weekly at ${weeklyAt} UTC on day ${WEEKLY_DAY}` : ''}`,
  );
  return { daily: dailyAt, weekly: weeklyAt };
}
