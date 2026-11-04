// The overview: a front page with a dial, a 14-day chart, breakdowns and source health.
// Hand-rolled SVG, no chart library. Every number is also on screen as text, every
// chart has a "Show the numbers" table, and color is never the only signal.
//
// Chart colors come from a validated categorical set (orange = Now, blue = Today /
// open items, aqua = Later): checked for colorblind separation on every Birddog
// surface in light and dark. Status colors (calm / busy / swamped) always come
// with an icon and a word.

import { esc, relTime, whenLabel } from './format.js';

const KIND_LABELS = {
  'review-request': 'Review requests', 'my-pr': 'Your PRs needing work', mention: 'Mentions', issue: 'Assigned issues',
  ticket: 'Tickets', meeting: 'Meetings', unpushed: 'Unpushed commits', uncommitted: 'Uncommitted work',
  'merged-branches': 'Merged branches', 'stale-branches': 'Stale branches',
};
const URG = [['now', 'Now'], ['today', 'Today'], ['later', 'Later']];
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Data

export function overviewData({ items, sources, history, now = Date.now() }) {
  const open = items.filter((i) => i.status === 'open');
  const count = (u) => open.filter((i) => i.urgency === u).length;
  const bySource = sources.map((s) => ({
    id: s.id, name: s.name,
    ...Object.fromEntries(URG.map(([u]) => [u, open.filter((i) => i.source === s.id && i.urgency === u).length])),
  })).map((r) => ({ ...r, total: r.now + r.today + r.later }));
  const kinds = {};
  for (const i of open) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  const byKind = Object.entries(kinds).map(([kind, n]) => ({ kind, label: KIND_LABELS[kind] ?? kind, n })).sort((a, b) => b.n - a.n);

  const prs = open.filter((i) => i.kind === 'review-request' || i.kind === 'my-pr').sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const longest = prs[0] ? { title: prs[0].title, url: prs[0].url, days: (now - Date.parse(prs[0].updatedAt)) / DAY, kind: prs[0].kind, id: prs[0].id } : null;

  const dayEnd = new Date(now); dayEnd.setHours(24, 0, 0, 0);
  const meetings = items.filter((i) => i.kind === 'meeting' && !i.meta?.allDay && i.meta?.startsAt && Date.parse(i.meta.startsAt) < dayEnd.getTime())
    .map((i) => ({ title: i.title.replace(/^[^·]+·\s*/, ''), start: Date.parse(i.meta.startsAt), end: Date.parse(i.meta.endsAt ?? i.meta.startsAt), id: i.id }))
    .sort((a, b) => a.start - b.start);
  const minutes = Math.round(meetings.reduce((m, x) => m + Math.max(0, x.end - Math.max(x.start, now)), 0) / 60_000);
  const next = meetings.find((m) => m.end > now) ?? null;

  const days = history.map((d) => ({ ...d }));
  const todayRow = days.at(-1);
  if (todayRow) Object.assign(todayRow, { open: open.length, now: count('now'), today: count('today'), later: count('later'), missing: false, done: todayRow.done ?? 0 });
  const weekAgo = days.at(-8);

  return {
    now: count('now'), today: count('today'), later: count('later'), open: open.length,
    weekAgoOpen: weekAgo && !weekAgo.missing ? weekAgo.open : null,
    doneToday: todayRow?.done ?? 0,
    bySource, byKind, longest, meetings: { count: meetings.filter((m) => m.end > now).length, minutes, next }, days,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Pieces

const fmt = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n));
const dur = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);
const ago = (days) => (days < 1 ? `${Math.max(1, Math.round(days * 24))} h` : `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`);

/** Load for the dial: what to call it, and its icon. */
export function loadLevel(n) {
  if (n <= 3) return { key: 'good', label: 'Calm', icon: '✓' };
  if (n <= 7) return { key: 'warn', label: 'Busy', icon: '!' };
  return { key: 'crit', label: 'Swamped', icon: '‼' };
}

function gauge(n) {
  const max = Math.max(10, n);
  const lvl = loadLevel(n);
  const W = 220; const H = 132; const cx = W / 2; const cy = 112; const r = 86;
  const pt = (f) => { const a = Math.PI * (1 - f); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const arc = (f0, f1) => { const [x0, y0] = pt(f0); const [x1, y1] = pt(f1); return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const f = Math.min(1, n / max);
  // Threshold ticks at 3 and 7, so the bands read without color.
  const ticks = [3, 7].map((v) => { const a = Math.PI * (1 - v / max); return `<line x1="${(cx + (r - 13) * Math.cos(a)).toFixed(1)}" y1="${(cy - (r - 13) * Math.sin(a)).toFixed(1)}" x2="${(cx + (r + 13) * Math.cos(a)).toFixed(1)}" y2="${(cy - (r + 13) * Math.sin(a)).toFixed(1)}" class="viz-tick"/>`; }).join('');
  return `<svg class="viz gauge" viewBox="0 0 ${W} ${H}" role="img" aria-label="${n} items need you now: ${lvl.label}">
    <path d="${arc(0, 1)}" class="gauge-track" />
    ${n > 0 ? `<path d="${arc(0, Math.max(f, 0.012))}" class="gauge-fill ${lvl.key}" />` : ''}
    ${ticks}
    <text x="${cx}" y="${cy - 18}" text-anchor="middle" class="gauge-value">${n}</text>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" class="gauge-sub">need you now</text>
    <text x="${cx - r}" y="${cy + 18}" text-anchor="middle" class="viz-axis-label">0</text>
    <text x="${cx + r}" y="${cy + 18}" text-anchor="middle" class="viz-axis-label">${max}${n > 10 ? '' : '+'}</text>
  </svg>
  <div class="gauge-state ${lvl.key}"><span class="ico" aria-hidden="true">${lvl.icon}</span>${lvl.label}<span class="viz-muted">calm ≤ 3 · busy 4–7 · swamped 8+</span></div>`;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function lineChart(days, width) {
  const W = Math.max(320, width); const H = 230;
  const m = { l: 34, r: 72, t: 12, b: 28 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const vals = days.filter((d) => !d.missing);
  const max = niceMax(Math.max(1, ...vals.map((d) => d.open)));
  const x = (i) => m.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v) => m.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max].map((v) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'viz-base' : 'viz-grid'}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" class="viz-axis-label">${fmt(v)}</text>`).join('');
  const path = (key) => {
    let d = ''; let pen = false;
    days.forEach((r, i) => { if (r.missing) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r[key]).toFixed(1)} `; pen = true; });
    return d.trim();
  };
  const area = (() => {
    const pts = days.map((r, i) => (r.missing ? null : [x(i), y(r.open)])).filter(Boolean);
    if (pts.length < 2) return '';
    return `M${pts[0][0]} ${y(0)} ${pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')} L${pts.at(-1)[0]} ${y(0)} Z`;
  })();
  const lastI = days.length - 1;
  const last = days[lastI];
  const labelEnd = (key, name, cls) => (last.missing ? '' : `<circle cx="${x(lastI)}" cy="${y(last[key])}" r="4" class="viz-dot ${cls}"/>`);
  // End labels: only when the two ends are far enough apart not to collide.
  const apart = !last.missing && Math.abs(y(last.open) - y(last.now)) >= 16;
  const endLabels = apart ? `<text x="${x(lastI) + 10}" y="${y(last.open) + 4}" class="viz-label">Open ${last.open}</text><text x="${x(lastI) + 10}" y="${y(last.now) + 4}" class="viz-label">Now ${last.now}</text>` : '';
  const step = days.length > 10 ? 3 : 1;
  const xl = days.map((d, i) => ((lastI - i) % step === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="viz-axis-label">${i === lastI ? 'Today' : esc(shortDay(d.date))}</text>` : '')).join('');
  const colW = iw / Math.max(1, days.length - 1);
  const hits = days.map((d, i) => `<rect x="${(x(i) - colW / 2).toFixed(1)}" y="${m.t}" width="${colW.toFixed(1)}" height="${ih}" class="viz-hit" data-col="${i}" tabindex="0" data-tip="${esc(tipFor(d))}" aria-label="${esc(tipFor(d))}"/>`).join('');
  return `<svg class="viz line" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Open items and items that need you now, over the last ${days.length} days. Today: ${last.missing ? 'no data' : `${last.open} open, ${last.now} now`}.">
    ${ticks}
    ${area ? `<path d="${area}" class="viz-area today"/>` : ''}
    <path d="${path('open')}" class="viz-line today"/>
    <path d="${path('now')}" class="viz-line now"/>
    ${labelEnd('open', 'Open', 'today')}${labelEnd('now', 'Now', 'now')}${endLabels}
    ${xl}
    <line class="viz-cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" style="display:none"/>
    ${hits}
  </svg>`;
}

function shortDay(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}
function tipFor(d) {
  const label = new Date(...d.date.split('-').map((v, i) => (i === 1 ? v - 1 : +v))).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return d.missing ? `${label}: no reading` : `${label} · ${d.open} open · ${d.now} now · ${d.done} done`;
}

function stackedBars(rows, width) {
  const shown = rows.filter((r) => r.total > 0);
  if (!shown.length) return '<div class="viz-empty">Nothing open in any source.</div>';
  const W = Math.max(300, width); const rowH = 34; const bh = 18;
  const m = { l: 92, r: 40 };
  const iw = W - m.l - m.r;
  const max = Math.max(...shown.map((r) => r.total));
  const H = shown.length * rowH + 4;
  const bars = shown.map((r, k) => {
    const yy = k * rowH + (rowH - bh) / 2;
    let xx = m.l;
    const segs = URG.filter(([u]) => r[u] > 0).map(([u, name], j, arr) => {
      const w = (r[u] / max) * iw;
      const gap = j < arr.length - 1 ? 2 : 0;
      const first = j === 0; const lastSeg = j === arr.length - 1;
      const rx = lastSeg ? 4 : 0;
      const seg = `<path d="${roundedRight(xx, yy, Math.max(1, w - gap), bh, rx)}" class="viz-seg ${u}" tabindex="0" data-tip="${esc(`${r.name}: ${r[u]} ${name}`)}" aria-label="${esc(`${r.name}: ${r[u]} ${name}`)}"/>`;
      xx += w;
      return first ? seg : seg;
    }).join('');
    return `<text x="${m.l - 10}" y="${yy + bh / 2 + 4}" text-anchor="end" class="viz-label">${esc(r.name)}</text>${segs}<text x="${xx + 8}" y="${yy + bh / 2 + 4}" class="viz-value">${r.total}</text>`;
  }).join('');
  return `<svg class="viz bars" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Open items by source: ${shown.map((r) => `${r.name} ${r.total} (${r.now} now)`).join(', ')}">${bars}</svg>`;
}

/** A bar that grows from a square baseline to a 4px rounded data-end. */
function roundedRight(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x} ${y} H${(x + w - rr).toFixed(1)} Q${(x + w).toFixed(1)} ${y} ${(x + w).toFixed(1)} ${y + rr} V${y + h - rr} Q${(x + w).toFixed(1)} ${y + h} ${(x + w - rr).toFixed(1)} ${y + h} H${x} Z`;
}

function kindBars(rows, width) {
  if (!rows.length) return '<div class="viz-empty">Nothing open.</div>';
  const W = Math.max(300, width); const rowH = 28; const bh = 14;
  const m = { l: 170, r: 36 };
  const iw = W - m.l - m.r;
  const max = Math.max(...rows.map((r) => r.n));
  const H = rows.length * rowH + 4;
  return `<svg class="viz bars" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Open items by kind: ${rows.map((r) => `${r.label} ${r.n}`).join(', ')}">${rows.map((r, k) => {
    const yy = k * rowH + (rowH - bh) / 2;
    const w = Math.max(2, (r.n / max) * iw);
    return `<text x="${m.l - 10}" y="${yy + bh / 2 + 4}" text-anchor="end" class="viz-label">${esc(r.label)}</text><path d="${roundedRight(m.l, yy, w, bh, 4)}" class="viz-seg today" tabindex="0" data-tip="${esc(`${r.label}: ${r.n}`)}" aria-label="${esc(`${r.label}: ${r.n}`)}"/><text x="${m.l + w + 8}" y="${yy + bh / 2 + 4}" class="viz-value">${r.n}</text>`;
  }).join('')}</svg>`;
}

const legend = (entries) => `<div class="viz-legend">${entries.map(([cls, name]) => `<span><i class="sw ${cls}" aria-hidden="true"></i>${esc(name)}</span>`).join('')}</div>`;

function table(head, rows) {
  return `<details class="viz-table"><summary>Show the numbers</summary><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<${i ? 'td' : 'th'}>${esc(c)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

function health(sources) {
  if (!sources.length) return '<div class="viz-empty">No sources switched on.</div>';
  return `<ul class="health">${sources.map((s) => {
    const st = s.status === 'ok' ? ['ok', '✓', `Updated ${relTime(s.lastSuccess)} · ${s.count} item${s.count === 1 ? '' : 's'}`]
      : s.status === 'stale' ? ['bad', '⚠', `Stale since ${whenLabel(s.staleSince)} · ${s.error ?? ''}`]
        : ['wait', '…', 'Checking…'];
    return `<li class="${st[0]}"><span class="ico" aria-hidden="true">${st[1]}</span><b>${esc(s.name)}</b><span class="viz-muted">${esc(st[2])}</span>${s.status === 'stale' ? `<button class="btn small" data-retry="${esc(s.id)}">↻ Retry</button>` : ''}</li>`;
  }).join('')}</ul>`;
}

// ---------------------------------------------------------------------------
// The page

export function overviewHTML(d, { width = 720 } = {}) {
  const half = Math.max(300, Math.floor((width - 16) / 2) - 34);
  const full = Math.max(320, width - 34);
  const delta = d.weekAgoOpen === null ? '' : (() => {
    const n = d.open - d.weekAgoOpen;
    return `<div class="tile-delta ${n <= 0 ? 'good' : 'bad'}">${n === 0 ? 'Same as' : n < 0 ? `▼ ${-n} fewer than` : `▲ ${n} more than`} a week ago</div>`;
  })();
  return `<div class="page-head"><h1>Overview</h1><span class="sub">What your day looks like</span><span style="flex:1"></span><button class="btn small" data-view="all">Go to inbox →</button></div>
  <div class="ov-grid">
    <section class="ov-card gauge-card"><h2>Load right now</h2>${gauge(d.now)}<div class="ov-mini">${URG.map(([u, n]) => `<span><i class="sw ${u}" aria-hidden="true"></i>${n} <b>${d[u]}</b></span>`).join('')}</div></section>
    <section class="ov-card tile"><h2>Open items</h2><div class="tile-value">${d.open}</div>${delta}<div class="viz-muted">${d.doneToday} done today</div></section>
    <section class="ov-card tile"><h2>Longest-waiting PR</h2>${d.longest
    ? `<div class="tile-value">${esc(ago(d.longest.days))}</div><a href="#" class="tile-link" data-ov-item="${esc(d.longest.id)}">${esc(d.longest.title)}</a><div class="viz-muted">${d.longest.kind === 'review-request' ? 'waiting for your review' : 'your PR, needs work'}</div>`
    : '<div class="tile-value">–</div><div class="viz-muted">No open reviews or PRs that need you</div>'}</section>
    <section class="ov-card tile"><h2>Meetings today</h2><div class="tile-value">${d.meetings.count}</div><div class="viz-muted">${d.meetings.minutes ? `${dur(d.meetings.minutes)} still booked` : 'Nothing left on the calendar'}</div>${d.meetings.next ? `<div class="tile-next">Next: <b>${esc(d.meetings.next.title)}</b> ${d.meetings.next.start > Date.now() ? `at ${esc(new Date(d.meetings.next.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : '(now)'}</div>` : ''}</section>

    <section class="ov-card wide"><h2>Last ${d.days.length} days</h2>${legend([['today', 'Open items'], ['now', 'Need you now']])}
      <div class="viz-wrap">${lineChart(d.days, full)}</div>
      ${table(['Day', 'Open', 'Now', 'Done'], d.days.map((r) => [r.date, r.missing ? '–' : r.open, r.missing ? '–' : r.now, r.missing ? '–' : r.done]))}</section>

    <section class="ov-card half"><h2>By source</h2>${legend(URG.map(([u, n]) => [u, n]))}
      <div class="viz-wrap">${stackedBars(d.bySource, half)}</div>
      ${table(['Source', 'Now', 'Today', 'Later', 'Total'], d.bySource.map((r) => [r.name, r.now, r.today, r.later, r.total]))}</section>
    <section class="ov-card half"><h2>By kind</h2>
      <div class="viz-wrap">${kindBars(d.byKind, half)}</div>
      ${table(['Kind', 'Open'], d.byKind.map((r) => [r.label, r.n]))}</section>

    <section class="ov-card wide"><h2>Source health</h2>${health(d.sources)}</section>
  </div>
  <div class="viz-tip" id="vizTip" role="tooltip" hidden></div>`;
}

/** Hover and keyboard focus on any [data-tip] mark show the tooltip; line-chart columns also show a crosshair. */
export function bindOverview(root) {
  const tip = root.querySelector('#vizTip');
  if (!tip) return;
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const box = root.getBoundingClientRect();
    tip.style.left = `${Math.min(x - box.left + 12, box.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${y - box.top + 14}px`;
    const svg = el.ownerSVGElement;
    const cross = svg?.querySelector('.viz-cross');
    if (cross && el.dataset.col !== undefined) {
      const cx = Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2;
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.display = '';
    }
  };
  const hide = (el) => {
    tip.hidden = true;
    el?.ownerSVGElement?.querySelector('.viz-cross')?.style.setProperty('display', 'none');
  };
  root.onmousemove = (e) => { const el = e.target.closest?.('[data-tip]'); if (el) show(el, e.clientX, e.clientY); else hide(); };
  root.onmouseleave = () => hide();
  root.onfocusin = (e) => { const el = e.target.closest?.('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); } };
  root.onfocusout = (e) => hide(e.target);
}
