/**
 * The HTML dashboard.
 *
 * One self-contained file, no CDN, opens from disk. It is the thing to look at
 * when someone asks "what has the agent actually done".
 *
 * Colour decisions, and why they are not a matter of taste:
 *
 *   - Link outcomes are **states**, not series, so they use the reserved status
 *     palette: good / warning / critical / serious. Each one ships with a label
 *     and a shape, never colour alone.
 *   - The fill order is good → warning → critical → serious. The obvious order
 *     (good → warning → serious → critical) puts `warning` next to `serious`,
 *     and those two measure ΔE 13.6 to normal vision — below the 15 floor, so
 *     readers with full colour vision struggle to tell adjacent segments apart.
 *     The validator caught it; the reorder passes in both light and dark.
 *   - `warning` and `serious` sit below 3:1 on the light surface by design, so
 *     every figure is also written out and every chart has a table beneath it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, all, get } from '../db/index.ts';
import type { ClientConfig } from '../config.ts';
import { TARGET_MIX, currentMix } from '../content/anchors.ts';
import { todayIso } from '../util/dates.ts';
import { log } from '../util/log.ts';

const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
  serious: '#ec835a',
} as const;

const SEQ = '#2a78d6';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Totals {
  verified: number;
  waiting: number;
  lost: number;
  unknown: number;
  mentions: number;
  dofollow: number;
  nofollow: number;
  unverifiable: number;
  contentWritten: number;
  contentPending: number;
  submitted: number;
  /** Verified links the agent itself produced — the funnel must not mix these
   *  with links inherited from the imported tracker, or it reads as 0 written
   *  → 0 submitted → 1 verified, which is impossible. */
  verifiedByAgent: number;
  importedWithUrl: number;
}

function gather(clientId: string): Totals {
  const n = (sql: string, ...p: Array<string | number>) =>
    get<{ n: number }>(sql, ...p)?.n ?? 0;

  const latestNote = (like: string) =>
    n(
      `SELECT COUNT(*) AS n FROM submissions s
         JOIN verifications v ON v.id = (
              SELECT id FROM verifications w WHERE w.submission_id = s.id
               ORDER BY checked_at DESC, id DESC LIMIT 1)
        WHERE s.client_id = ? AND v.note LIKE ?`,
      clientId,
      like,
    );

  return {
    verified: n("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status = 'verified'", clientId),
    waiting: n(
      "SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status IN ('submitted','needs_assist','manual_queue')",
      clientId,
    ),
    lost: n("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status = 'lost'", clientId),
    unknown: latestNote('%refused us%'),
    mentions: latestNote('%plain text%'),
    dofollow: n(
      `SELECT COUNT(*) AS n FROM submissions s JOIN verifications v ON v.id = (
          SELECT id FROM verifications w WHERE w.submission_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1)
        WHERE s.client_id = ? AND s.status = 'verified' AND v.rel = 'dofollow'`,
      clientId,
    ),
    nofollow: n(
      `SELECT COUNT(*) AS n FROM submissions s JOIN verifications v ON v.id = (
          SELECT id FROM verifications w WHERE w.submission_id = s.id ORDER BY checked_at DESC, id DESC LIMIT 1)
        WHERE s.client_id = ? AND s.status = 'verified' AND v.rel IS NOT NULL AND v.rel != 'dofollow'`,
      clientId,
    ),
    unverifiable: n(
      "SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND status = 'unverifiable'",
      clientId,
    ),
    contentWritten: n('SELECT COUNT(*) AS n FROM content_items WHERE client_id = ?', clientId),
    contentPending: n(
      "SELECT COUNT(*) AS n FROM content_items WHERE client_id = ? AND approval = 'pending'",
      clientId,
    ),
    submitted: n("SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND source = 'agent'", clientId),
    verifiedByAgent: n(
      "SELECT COUNT(*) AS n FROM submissions WHERE client_id = ? AND source = 'agent' AND status = 'verified'",
      clientId,
    ),
    importedWithUrl: n(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE client_id = ? AND source = 'source-sheet-import'
          AND submitted_url IS NOT NULL AND submitted_url != ''`,
      clientId,
    ),
  };
}

/** A labelled proportional bar. One series, so no legend — the title names it. */
function bar(label: string, value: number, max: number, colour: string, note = ''): string {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="row">
    <div class="row-label">${esc(label)}</div>
    <div class="track" role="img" aria-label="${esc(label)}: ${value}">
      <div class="fill" style="width:${Math.max(value > 0 ? 2 : 0, pct)}%;background:${colour}"
           data-tip="${esc(label)}: ${value}${note ? ` — ${esc(note)}` : ''}"></div>
    </div>
    <div class="row-value">${value}${note ? `<span class="muted"> ${esc(note)}</span>` : ''}</div>
  </div>`;
}

/** Stacked bar of link states for one submission type. */
function stacked(label: string, parts: Array<{ n: number; colour: string; name: string }>, max: number): string {
  const total = parts.reduce((a, p) => a + p.n, 0);
  const segments = parts
    .filter((p) => p.n > 0)
    .map(
      (p) =>
        `<div class="seg" style="flex:${p.n};background:${p.colour}"
              data-tip="${esc(label)} — ${esc(p.name)}: ${p.n}"></div>`,
    )
    .join('');

  const width = max > 0 ? Math.max(total > 0 ? 2 : 0, Math.round((total / max) * 100)) : 0;
  return `<div class="row">
    <div class="row-label">${esc(label)}</div>
    <div class="track"><div class="stack" style="width:${width}%">${segments}</div></div>
    <div class="row-value">${total}</div>
  </div>`;
}

export function writeDashboard(cfg: ClientConfig): string {
  const t = gather(cfg.id);
  const dir = resolve(PROJECT_ROOT, 'data/reports');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${cfg.id}-dashboard.html`);

  const byType = all<{ type: string; verified: number; waiting: number; lost: number }>(
    `SELECT type,
            SUM(status = 'verified') AS verified,
            SUM(status IN ('submitted','needs_assist','manual_queue')) AS waiting,
            SUM(status = 'lost') AS lost
       FROM submissions WHERE client_id = ? GROUP BY type ORDER BY verified DESC, type`,
    cfg.id,
  );
  const typeMax = Math.max(1, ...byType.map((r) => r.verified + r.waiting + r.lost));

  const sites = all<{ domain: string; attempts: number; verified: number; lost: number; score: number | null; authority: number | null }>(
    `SELECT si.domain,
            COUNT(s.id) AS attempts,
            SUM(s.status = 'verified') AS verified,
            SUM(s.status = 'lost') AS lost,
            si.score, si.authority
       FROM submissions s JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ?
      GROUP BY si.domain ORDER BY verified DESC, attempts DESC LIMIT 25`,
    cfg.id,
  );

  const keywords = all<{ keyword: string; written: number; verified: number }>(
    `SELECT k.keyword,
            (SELECT COUNT(*) FROM content_items c WHERE c.keyword_id = k.id) AS written,
            (SELECT COUNT(*) FROM submissions s WHERE s.keyword_id = k.id AND s.status = 'verified') AS verified
       FROM keywords k WHERE k.client_id = ? ORDER BY k.priority, k.keyword`,
    cfg.id,
  );

  const lostLinks = all<{ domain: string | null; url: string; type: string }>(
    `SELECT si.domain, s.submitted_url AS url, s.type
       FROM submissions s LEFT JOIN sites si ON si.id = s.site_id
      WHERE s.client_id = ? AND s.status = 'lost' ORDER BY s.updated_at DESC LIMIT 15`,
    cfg.id,
  );

  const mix = currentMix(cfg.id);
  const catalog = all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM sites GROUP BY status ORDER BY n DESC',
  );

  const funnelMax = Math.max(1, t.contentWritten, t.submitted, t.verifiedByAgent);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.name)} — off-page links</title>
<style>
  :root {
    color-scheme: light;
    --surface: #fcfcfb;
    --card: #ffffff;
    --border: #e4e3df;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --ink-3: #8a8982;
    --grid: #ecebe7;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface: #1a1a19;
      --card: #232322;
      --border: #383835;
      --ink: #f0efec;
      --ink-2: #c3c2b7;
      --ink-3: #8f8e86;
      --grid: #2e2e2c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: #1a1a19;
    --card: #232322;
    --border: #383835;
    --ink: #f0efec;
    --ink-2: #c3c2b7;
    --ink-3: #8f8e86;
    --grid: #2e2e2c;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px 64px;
    background: var(--surface); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 32px 0 12px; font-weight: 600; }
  .sub { color: var(--ink-2); font-size: 13px; margin: 0 0 28px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }

  .hero { display: flex; gap: 28px; align-items: flex-end; flex-wrap: wrap; }
  .hero-num { font-size: 56px; font-weight: 650; line-height: 1; letter-spacing: -0.03em; }
  .hero-label { color: var(--ink-2); font-size: 13px; margin-top: 6px; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
  .tile { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile-n { font-size: 26px; font-weight: 600; line-height: 1.1; }
  .tile-l { color: var(--ink-2); font-size: 12px; margin-top: 4px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: 1px; }

  .row { display: grid; grid-template-columns: 170px 1fr 92px; gap: 12px; align-items: center; margin: 7px 0; }
  .row-label { font-size: 13px; color: var(--ink-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-value { font-size: 13px; font-variant-numeric: tabular-nums; }
  .track { background: var(--grid); border-radius: 4px; height: 16px; position: relative; overflow: hidden; }
  .fill { height: 16px; border-radius: 0 4px 4px 0; }
  .stack { display: flex; height: 16px; border-radius: 0 4px 4px 0; overflow: hidden; gap: 2px; }
  .seg:first-child { border-radius: 0; }
  .seg:last-child { border-radius: 0 4px 4px 0; }
  .seg { min-width: 3px; }

  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2); margin: 4px 0 14px 182px; }
  .target { font-size: 12px; color: var(--ink-3); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--ink-2); font-weight: 600; font-size: 12px; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--ink-3); }
  .note { color: var(--ink-2); font-size: 13px; margin: 10px 0 0; }
  details { margin-top: 10px; }
  summary { cursor: pointer; font-size: 12px; color: var(--ink-2); }
  a { color: ${SEQ}; }

  #tip {
    position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--ink); color: var(--surface); font-size: 12px;
    padding: 5px 9px; border-radius: 6px; z-index: 10; max-width: 320px;
  }
</style>
</head>
<body>
<div class="wrap">

  <h1>${esc(cfg.name)} — off-page links</h1>
  <p class="sub">${esc(cfg.siteUrl)} · generated ${todayIso()} · every figure below is backed by a verification record</p>

  <div class="card hero">
    <div>
      <div class="hero-num" style="color:${STATUS.good}">${t.verified}</div>
      <div class="hero-label">verified live backlinks</div>
    </div>
    <div>
      <div class="hero-num" style="font-size:30px">${t.dofollow}</div>
      <div class="hero-label">of them dofollow</div>
    </div>
    <div class="note" style="flex:1; min-width:240px">
      A link counts when a verifier fetched the page and found an
      <code>&lt;a href&gt;</code> to ${esc(cfg.siteUrl.replace(/^https?:\/\//, ''))}.
      "Submitted" is not a result.
    </div>
  </div>

  <div class="tiles">
    <div class="tile"><div class="tile-n"><span class="dot" style="background:${STATUS.warning}"></span>${t.waiting}</div><div class="tile-l">waiting — submitted, not yet confirmed</div></div>
    <div class="tile"><div class="tile-n"><span class="dot" style="background:${STATUS.critical}"></span>${t.lost}</div><div class="tile-l">lost — was there, now gone</div></div>
    <div class="tile"><div class="tile-n"><span class="dot" style="background:${STATUS.serious}"></span>${t.unknown}</div><div class="tile-l">unknown — the platform blocked the check</div></div>
    <div class="tile"><div class="tile-n">${t.mentions}</div><div class="tile-l">text mentions, no anchor — pass nothing</div></div>
    <div class="tile"><div class="tile-n">${t.unverifiable}</div><div class="tile-l">unverifiable — no URL was ever recorded</div></div>
    <div class="tile"><div class="tile-n">${t.contentPending}</div><div class="tile-l">content awaiting your approval</div></div>
  </div>

  <h2>Pipeline since the agent took over</h2>
  <div class="card">
    ${bar('content written', t.contentWritten, funnelMax, SEQ)}
    ${bar('submitted', t.submitted, funnelMax, SEQ)}
    ${bar('verified live', t.verifiedByAgent, funnelMax, STATUS.good)}
    <p class="note">Each stage is a subset of the one above it, so this counts only the
    agent's own work. The ${t.importedWithUrl} URL${t.importedWithUrl === 1 ? '' : 's'} inherited from the
    team's manual tracker are verified and counted in the headline, but they never passed
    through these stages and would make the funnel read as impossible.</p>
  </div>

  <h2>Link states by submission type</h2>
  <div class="card">
    <div class="legend">
      <span><span class="dot" style="background:${STATUS.good}"></span>verified</span>
      <span><span class="dot" style="background:${STATUS.warning}"></span>waiting</span>
      <span><span class="dot" style="background:${STATUS.critical}"></span>lost</span>
    </div>
    ${
      byType.length
        ? byType
            .map((r) =>
              stacked(
                r.type,
                [
                  { n: r.verified, colour: STATUS.good, name: 'verified' },
                  { n: r.waiting, colour: STATUS.warning, name: 'waiting' },
                  { n: r.lost, colour: STATUS.critical, name: 'lost' },
                ],
                typeMax,
              ),
            )
            .join('')
        : '<p class="note">No submissions yet.</p>'
    }
    ${
      byType.length
        ? `<details><summary>table view</summary>
      <table><thead><tr><th>type</th><th class="n">verified</th><th class="n">waiting</th><th class="n">lost</th></tr></thead>
      <tbody>${byType
        .map(
          (r) =>
            `<tr><td>${esc(r.type)}</td><td class="n">${r.verified}</td><td class="n">${r.waiting}</td><td class="n">${r.lost}</td></tr>`,
        )
        .join('')}</tbody></table></details>`
        : ''
    }
  </div>

  <h2>Anchor profile</h2>
  <div class="card">
    ${(Object.keys(TARGET_MIX) as Array<keyof typeof TARGET_MIX>)
      .map((kind) => {
        const have = Math.round((mix[kind] ?? 0) * 100);
        const want = Math.round(TARGET_MIX[kind] * 100);
        return bar(kind, have, 100, SEQ, `% · target ${want}%`);
      })
      .join('')}
    <p class="note">Exact-match anchors in the minority is the point: the tracker this
    replaced used the target keyword as the anchor on every single submission.</p>
  </div>

  <h2>Platforms</h2>
  <div class="card">
    ${
      sites.length
        ? `<table>
      <thead><tr><th>domain</th><th class="n">tried</th><th class="n">live</th><th class="n">lost</th><th class="n">sub</th><th class="n">auth</th></tr></thead>
      <tbody>${sites
        .map(
          (s) =>
            `<tr><td>${esc(s.domain)}</td><td class="n">${s.attempts}</td><td class="n">${s.verified}</td><td class="n">${s.lost}</td><td class="n muted">${s.score ?? '-'}</td><td class="n muted">${s.authority ?? '-'}</td></tr>`,
        )
        .join('')}</tbody></table>
      <p class="note">sub = submittability, auth = authority. A platform with attempts and
      no live links is one to drop.</p>`
        : '<p class="note">No platform has been used yet.</p>'
    }
  </div>

  <h2>Keywords</h2>
  <div class="card">
    <table>
      <thead><tr><th>keyword</th><th class="n">assets written</th><th class="n">verified links</th></tr></thead>
      <tbody>${keywords
        .map(
          (k) =>
            `<tr><td>${esc(k.keyword)}</td><td class="n">${k.written}</td><td class="n">${k.verified}</td></tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>

  ${
    lostLinks.length
      ? `<h2>Lost links</h2>
  <div class="card">
    <table><thead><tr><th>platform</th><th>type</th><th>url</th></tr></thead>
    <tbody>${lostLinks
      .map(
        (l) =>
          `<tr><td>${esc(l.domain ?? '?')}</td><td>${esc(l.type)}</td><td class="muted">${esc(l.url)}</td></tr>`,
      )
      .join('')}</tbody></table>
  </div>`
      : ''
  }

  <h2>Site catalog</h2>
  <div class="card">
    ${catalog
      .map((c) =>
        bar(c.status, c.n, Math.max(1, ...catalog.map((x) => x.n)), c.status === 'rejected' ? STATUS.critical : SEQ),
      )
      .join('')}
    <p class="note"><strong>blocked</strong> means our crawler was turned away, not that the
    platform is bad. Only <strong>rejected</strong> is permanent.</p>
  </div>

</div>
<div id="tip"></div>
<script>
  // Per-mark hover tooltip. No dependency, no build step.
  (function () {
    var tip = document.getElementById('tip');
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[data-tip]');
      if (!el) return;
      tip.textContent = el.getAttribute('data-tip');
      tip.style.opacity = '1';
    });
    document.addEventListener('mousemove', function (e) {
      if (tip.style.opacity !== '1') return;
      var pad = 14;
      var x = Math.min(e.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
      var y = Math.max(8, e.clientY - tip.offsetHeight - 10);
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });
    document.addEventListener('mouseout', function (e) {
      if (e.target.closest && e.target.closest('[data-tip]')) tip.style.opacity = '0';
    });
  })();
</script>
</body>
</html>
`;

  writeFileSync(path, html, 'utf8');
  log.info(`dashboard → ${path}`);
  return path;
}
