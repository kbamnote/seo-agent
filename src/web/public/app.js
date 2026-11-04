/*
 * The whole frontend. No framework and no build step, to match the rest of the
 * project: one fetch per view, render to innerHTML, re-render after an action.
 *
 * Everything the user types or that comes out of the database goes through
 * esc() before it reaches innerHTML. Article text is machine-written and a
 * platform name could contain anything; an admin page that trusts its own
 * database is how a stored XSS starts.
 */

const main = document.getElementById('main');
const toastEl = document.getElementById('toast');
let state = { view: 'overview', selected: null, cache: {} };

// ── helpers ─────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

async function api(path, options) {
  const res = await fetch('/api/' + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

let toastTimer;
function toast(message, bad) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastEl.style.background = bad ? 'var(--critical)' : 'var(--ink)';
  toastEl.style.color = bad ? '#fff' : 'var(--surface)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

function chip(status) {
  const map = {
    verified: ['chip-verified', 'verified'],
    submitted: ['chip-waiting', 'submitted'],
    manual_queue: ['chip-waiting', 'with a human'],
    needs_assist: ['chip-waiting', 'needs you'],
    lost: ['chip-lost', 'lost'],
    failed: ['chip-lost', 'failed'],
    unverifiable: ['chip-unknown', 'no URL'],
    pending: ['chip-waiting', 'pending'],
    approved: ['chip-verified', 'approved'],
    not_required: ['chip-verified', 'auto'],
    rejected: ['chip-lost', 'rejected'],
  };
  const [cls, label] = map[status] || ['chip-plain', status];
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

/** Minimal markdown: headings, bold, links, paragraphs. Nothing else is used. */
function markdown(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) =>
        /^https?:\/\//i.test(href)
          ? `<a class="link-here" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`
          : esc(label),
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      const h = /^(#{1,6})\s+(.*)$/.exec(b);
      if (h) {
        const level = Math.min(h[1].length + 1, 4);
        return `<h${level}>${inline(h[2])}</h${level}>`;
      }
      return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function copyText(text, what) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${what} copied`))
    .catch(() => toast('Could not copy — select the text instead', true));
}

// ── views ───────────────────────────────────────────────────────────────────

const views = {};

views.overview = async () => {
  const o = await api('overview');
  state.cache.overview = o;
  document.getElementById('client-name').textContent = o.client.name;
  document.getElementById('client-site').textContent = o.client.siteUrl.replace(/^https?:\/\//, '');

  const q = o.quota;
  const tile = (n, label, colour) =>
    `<div class="tile"><div class="tile-n">${
      colour ? `<span class="dot" style="background:${colour}"></span>` : ''
    }${n}</div><div class="tile-l">${esc(label)}</div></div>`;

  return `
    <h2>Links</h2>
    <div class="tiles">
      ${tile(o.links.verified, 'verified live', 'var(--good)')}
      ${tile(o.links.dofollow, 'of those, dofollow')}
      ${tile(o.links.waiting, 'waiting', 'var(--warning)')}
      ${tile(o.links.lost, 'lost', 'var(--critical)')}
      ${tile(o.links.unknown, 'platform blocked the check', 'var(--serious)')}
      ${tile(o.links.mentions, 'text mentions, not links')}
      ${tile(o.links.unverifiable, 'no URL ever recorded')}
    </div>

    <h2>Content</h2>
    <div class="tiles">
      ${tile(o.content.pending, 'awaiting your approval')}
      ${tile(o.content.ready, 'approved, ready to send')}
      ${tile(o.content.total, 'written in total')}
    </div>

    <h2>Anchor profile</h2>
    <div class="card">
      ${o.anchors
        .map(
          (a) => `<div class="barrow">
            <span class="dim">${esc(a.kind)}</span>
            <span class="bar"><div style="width:${Math.max(a.have ? 2 : 0, a.have)}%"></div></span>
            <span class="dim">${a.have}% · target ${a.target}%</span>
          </div>`,
        )
        .join('')}
    </div>

    <h2>Today's quota</h2>
    <div class="card">
      <p class="dim" style="margin-top:0">${q.totalUsed} used, <b>${q.totalLeft} left</b>, ${q.minutesBetween} minutes between sends.</p>
      <table><thead><tr><th>type</th><th class="n">used</th><th class="n">limit</th></tr></thead><tbody>
        ${q.byType.map((t) => `<tr><td>${esc(t.type)}</td><td class="n">${t.used}</td><td class="n">${t.limit}</td></tr>`).join('')}
      </tbody></table>
    </div>

    <h2>Running things</h2>
    <div class="card">
      <p class="dim" style="margin-top:0">This page reads and decides. Anything that writes to the
      internet runs in a terminal, on purpose — a web button that starts processes is a door worth
      locking.</p>
      <code class="cmd">npm run generate -- --type blog</code>
      <code class="cmd">npm run submit -- run -n 1</code>
      <code class="cmd">npm run verify</code>
      <code class="cmd">npm run doctor</code>
    </div>`;
};

views.approvals = async () => {
  const items = await api('content?filter=pending');
  state.cache.pending = items;
  badge('badge-approvals', items.length);

  if (!items.length) {
    return `<div class="card"><p class="dim" style="margin:0">Nothing is waiting for approval.</p>
      <p class="muted">Blog articles land here; everything else submits automatically.</p></div>`;
  }

  if (!state.selected || !items.some((i) => i.id === state.selected)) state.selected = items[0].id;

  const list = items
    .map(
      (i) => `<div class="list-item ${i.id === state.selected ? 'on' : ''}" data-id="${i.id}">
        <div class="t">${esc(i.title)}</div>
        <div class="s">#${i.id} · ${esc(i.type)} · ${i.words || '?'}w · ${esc(i.site || 'no platform')}</div>
      </div>`,
    )
    .join('');

  return `<div class="split">
    <div class="list">${list}</div>
    <div id="reader" class="reader"><p class="muted">Loading…</p></div>
  </div>`;
};

async function renderReader() {
  const host = document.getElementById('reader');
  if (!host || !state.selected) return;
  let item;
  try {
    item = await api('content/' + state.selected);
  } catch (err) {
    host.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    return;
  }

  const template = item.generator === 'template';
  host.innerHTML = `
    <div class="meta">
      <b>#${item.id}</b> · ${esc(item.type)} · ${esc(item.keyword || 'no keyword')}
      · for <b>${esc(item.site || 'no platform')}</b> · ${item.word_count || '?'} words
      · written by ${esc(item.generator)}${item.model ? ' (' + esc(item.model) + ')' : ''}
      <br>anchor <b>${esc(item.anchor_text)}</b> (${esc(item.anchor_kind)}) &rarr;
      <a href="${esc(item.target_url)}" target="_blank" rel="noopener">${esc(item.target_url)}</a>
      ${template ? '<br><span class="chip chip-lost">template — placeholder text, not publishable</span>' : ''}
    </div>
    <div class="doc">${markdown(item.text)}</div>
    <div class="actions">
      <button class="act primary" id="btn-approve" ${template ? 'disabled' : ''}>Approve</button>
      <button class="act danger" id="btn-reject">Reject</button>
      <button class="act ghost" id="btn-copy">Copy text</button>
      ${item.asset_path ? `<span class="muted" style="align-self:center">${esc(item.asset_path)}</span>` : ''}
    </div>`;

  document.getElementById('btn-approve').onclick = () => decide(item.id, 'approve');
  document.getElementById('btn-reject').onclick = () => decide(item.id, 'reject');
  document.getElementById('btn-copy').onclick = () => copyText(item.text, 'Article');
}

async function decide(id, action) {
  try {
    await api(`content/${id}/${action}`, { method: 'POST', body: '{}' });
    toast(`#${id} ${action === 'approve' ? 'approved' : 'rejected'}`);
    state.selected = null;
    await show('approvals');
  } catch (err) {
    toast(err.message, true);
  }
}

views.manual = async () => {
  const items = await api('manual');
  badge('badge-manual', items.length);

  if (!items.length) {
    return `<div class="card"><p class="dim" style="margin:0">Nothing waiting for a human.</p>
      <p class="muted">Platforms whose terms forbid automation land here with the post written and ready.</p></div>`;
  }

  return items
    .map(
      (i) => `<div class="card" style="margin-bottom:14px">
      <div class="row" style="justify-content:space-between">
        <div><b>${esc(i.site)}</b> <span class="muted">· ${esc(i.type)} · record id ${i.id}</span></div>
        ${chip(i.status)}
      </div>
      <p class="muted" style="margin:8px 0 0">anchor <b>${esc(i.anchor || '')}</b> &rarr; ${esc(i.targetUrl || '')}
      ${i.keyword ? ' · ' + esc(i.keyword) : ''}</p>

      <div class="row" style="margin-top:12px">
        <button class="act" data-copy="title" data-id="${i.id}">Copy title</button>
        <button class="act" data-copy="body" data-id="${i.id}">Copy body</button>
        <button class="act ghost" data-toggle="${i.id}">Show text</button>
        <a class="act ghost" style="text-decoration:none" href="https://${esc(i.site)}" target="_blank" rel="noopener">Open ${esc(i.site)}</a>
      </div>

      <div id="text-${i.id}" hidden>
        <pre class="copy">${esc(i.title)}</pre>
        <pre class="copy">${esc(i.body)}</pre>
        ${i.assetPath ? `<p class="muted">file: ${esc(i.assetPath)}</p>` : ''}
      </div>

      <div class="row" style="margin-top:12px">
        <input type="url" id="url-${i.id}" placeholder="Paste the URL you posted it at">
        <button class="act primary" data-record="${i.id}">Record</button>
      </div>
    </div>`,
    )
    .join('');
};

views.queue = async () => {
  const items = await api('queue');
  if (!items.length) {
    return `<div class="card"><p class="dim" style="margin:0">Nothing is ready to send.</p>
      <p class="muted">Work needs approved, non-template content tied to a vetted platform, within quota,
      and not already submitted.</p></div>`;
  }
  return `<div class="card"><table>
    <thead><tr><th>platform</th><th>type</th><th>content</th><th>anchor</th><th>adapter</th></tr></thead>
    <tbody>${items
      .map(
        (i) => `<tr>
          <td><b>${esc(i.site)}</b></td>
          <td>${esc(i.type)}</td>
          <td>#${i.contentId} ${esc(i.title)}</td>
          <td>${esc(i.anchor)}</td>
          <td>${esc(i.adapter)}${i.confidence === 'untested' ? ' <span class="chip chip-unknown">untested</span>' : ''}</td>
        </tr>`,
      )
      .join('')}</tbody></table>
    <p class="muted">Send them with <code>npm run submit -- run -n 1</code>.</p>
  </div>`;
};

views.links = async () => {
  const items = await api('links');
  if (!items.length) return `<div class="card"><p class="dim" style="margin:0">No submissions yet.</p></div>`;

  return `<div class="card"><table>
    <thead><tr><th>status</th><th>platform</th><th>type</th><th>url</th><th>rel</th><th>checked</th></tr></thead>
    <tbody>${items
      .map(
        (i) => `<tr>
          <td>${chip(i.status)}</td>
          <td>${esc(i.site || '-')}</td>
          <td>${esc(i.type)}</td>
          <td>${
            i.url
              ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(
                  i.url.replace(/^https?:\/\//, '').slice(0, 58),
                )}</a>`
              : '<span class="muted">none recorded</span>'
          }${i.note ? `<div class="muted" style="font-size:11.5px">${esc(i.note.slice(0, 90))}</div>` : ''}</td>
          <td>${i.rel ? esc(i.rel) : '<span class="muted">-</span>'}</td>
          <td class="muted">${esc((i.checkedAt || '').slice(0, 10) || '-')}</td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
};

views.catalog = async () => {
  const items = await api('sites');
  return `<div class="card"><table>
    <thead><tr><th>domain</th><th class="n">sub</th><th class="n">auth</th><th>status</th><th>flags</th><th>set</th></tr></thead>
    <tbody>${items
      .map(
        (s) => `<tr>
          <td><a href="${esc(s.homeUrl || 'https://' + s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a>
            ${s.reason ? `<div class="muted" style="font-size:11.5px">${esc(s.reason.slice(0, 70))}</div>` : ''}</td>
          <td class="n">${s.score ?? '-'}</td>
          <td class="n">${s.authority ?? '-'}</td>
          <td>${chip(s.status)}</td>
          <td class="muted" style="font-size:11.5px">${[
            s.blocklisted ? 'blocklisted' : '',
            s.manualOnly ? 'manual only' : '',
            s.adapter ? 'adapter:' + esc(s.adapter) : '',
            s.captcha ? 'captcha' : '',
            s.failures ? s.failures + ' failures' : '',
          ]
            .filter(Boolean)
            .join(' · ')}</td>
          <td>${
            s.blocklisted
              ? '<span class="muted">locked</span>'
              : `<button class="act" data-site="${esc(s.domain)}" data-status="vetted">vetted</button>
                 <button class="act danger" data-site="${esc(s.domain)}" data-status="rejected">reject</button>`
          }</td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
};

// ── wiring ──────────────────────────────────────────────────────────────────

function badge(id, n) {
  const el = document.getElementById(id);
  el.textContent = n;
  el.hidden = !n;
}

async function show(view) {
  state.view = view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  main.innerHTML = '<p class="muted pad">Loading…</p>';
  try {
    main.innerHTML = await views[view]();
  } catch (err) {
    main.innerHTML = `<div class="card"><p style="margin:0">${esc(err.message)}</p></div>`;
    return;
  }
  if (view === 'approvals') await renderReader();
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) show(btn.dataset.view);
});

document.getElementById('refresh').addEventListener('click', () => show(state.view));

// One delegated handler for everything the views render.
main.addEventListener('click', async (e) => {
  const item = e.target.closest('.list-item');
  if (item) {
    state.selected = Number(item.dataset.id);
    document.querySelectorAll('.list-item').forEach((n) => n.classList.toggle('on', n === item));
    await renderReader();
    return;
  }

  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const box = document.getElementById('text-' + toggle.dataset.toggle);
    box.hidden = !box.hidden;
    toggle.textContent = box.hidden ? 'Show text' : 'Hide text';
    return;
  }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const box = document.getElementById('text-' + copy.dataset.id);
    const pre = box.querySelectorAll('pre');
    const which = copy.dataset.copy === 'title' ? 0 : 1;
    copyText(pre[which].textContent, copy.dataset.copy === 'title' ? 'Title' : 'Body');
    return;
  }

  const record = e.target.closest('[data-record]');
  if (record) {
    const id = record.dataset.record;
    const input = document.getElementById('url-' + id);
    try {
      await api(`submissions/${id}/record`, {
        method: 'POST',
        body: JSON.stringify({ url: input.value, operator: 'web' }),
      });
      toast(`#${id} recorded — it will be verified on the next run`);
      await show('manual');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  const site = e.target.closest('[data-site]');
  if (site) {
    try {
      await api(`sites/${encodeURIComponent(site.dataset.site)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: site.dataset.status }),
      });
      toast(`${site.dataset.site} → ${site.dataset.status}`);
      await show('catalog');
    } catch (err) {
      toast(err.message, true);
    }
  }
});

// Keep the two badges current even when you are on another view.
async function refreshBadges() {
  try {
    const o = await api('overview');
    badge('badge-approvals', o.content.pending);
    const manual = await api('manual');
    badge('badge-manual', manual.length);
    document.getElementById('client-name').textContent = o.client.name;
    document.getElementById('client-site').textContent = o.client.siteUrl.replace(/^https?:\/\//, '');
  } catch {
    /* the server may be restarting; the next tick will catch up */
  }
}

refreshBadges();
show('overview');
