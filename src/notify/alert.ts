/**
 * Operator alerts.
 *
 * Scheduled runs happen while nobody is watching, so anything that needs a
 * person has to reach them. This is the one place that decides what is worth
 * interrupting someone for.
 *
 * What alerts: a link that was live and is now gone, a submission stuck waiting
 * for a human, and a run that failed. What does not: ordinary progress, quota
 * exhaustion (that is the system working), and anything the next daily run will
 * handle by itself. An alert channel that cries wolf gets muted, and then the
 * real alert is missed too.
 */

import { all, run } from '../db/index.ts';
import { log } from '../util/log.ts';

export type AlertKind = 'lost_links' | 'needs_assist' | 'run_failed' | 'nothing_to_do';

export interface Alert {
  kind: AlertKind;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  lines: string[];
}

/** Sends through the existing Tapify WhatsApp sender, if configured. */
export async function sendWhatsApp(message: string): Promise<boolean> {
  const endpoint = process.env.TAPIFY_WA_ENDPOINT?.trim();
  const to = process.env.OPERATOR_WHATSAPP?.trim();
  if (!endpoint || !to) return false;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.debug(`WhatsApp alert returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.debug(`WhatsApp alert failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

function format(clientId: string, alert: Alert): string {
  return [`[${clientId}] ${alert.title}`, ...alert.lines.slice(0, 8)].join('\n');
}

export async function dispatch(clientId: string, alerts: Alert[]): Promise<void> {
  const worth = alerts.filter((a) => a.severity !== 'info');
  if (!worth.length) {
    log.info('nothing worth alerting about');
    return;
  }

  for (const alert of worth) {
    const text = format(clientId, alert);
    const emit = alert.severity === 'critical' ? log.error : log.warn;
    emit(`\n${text}\n`);

    const sent = await sendWhatsApp(text);
    run(
      `INSERT INTO runs (kind, client_id, finished_at, status, stats_json)
       VALUES ('alert', ?, datetime('now'), ?, ?)`,
      clientId,
      sent ? 'ok' : 'not_sent',
      JSON.stringify({ kind: alert.kind, severity: alert.severity, title: alert.title }),
    );
  }

  if (!process.env.OPERATOR_WHATSAPP?.trim()) {
    log.info('set OPERATOR_WHATSAPP and TAPIFY_WA_ENDPOINT in .env to get these on your phone');
  }
}

/** Links that went from live to gone since the last sweep. */
export function lostSinceAlert(clientId: string, hours = 48): Alert | null {
  const rows = all<{ domain: string | null; url: string; type: string }>(
    `SELECT si.domain, s.submitted_url AS url, s.type
       FROM submissions s LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ? AND s.status = 'lost'
        AND s.updated_at > datetime('now', ?)
      ORDER BY s.updated_at DESC`,
    clientId,
    `-${hours} hours`,
  );
  if (!rows.length) return null;

  return {
    kind: 'lost_links',
    severity: 'critical',
    title: `${rows.length} backlink${rows.length === 1 ? '' : 's'} went missing`,
    lines: rows.map((r) => `- ${r.domain ?? '?'} (${r.type}): ${r.url}`),
  };
}

/** Submissions parked waiting for a person. */
export function assistAlert(clientId: string): Alert | null {
  const rows = all<{ domain: string | null; type: string; last_error: string | null }>(
    `SELECT si.domain, s.type, s.last_error
       FROM submissions s LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ? AND s.status = 'needs_assist'`,
    clientId,
  );
  if (!rows.length) return null;

  return {
    kind: 'needs_assist',
    severity: 'warn',
    title: `${rows.length} submission${rows.length === 1 ? '' : 's'} waiting for you`,
    lines: rows.map((r) => `- ${r.domain ?? '?'} (${r.type}): ${r.last_error ?? 'needs a human'}`),
  };
}

export function failureAlert(clientId: string, step: string, err: unknown): Alert {
  return {
    kind: 'run_failed',
    severity: 'critical',
    title: `scheduled run failed at "${step}"`,
    lines: [String(err instanceof Error ? err.message : err).slice(0, 400)],
  };
}
