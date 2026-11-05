// The Work views: the ticket board (Jira swimlanes) and Worktrees & slots
// (git worktrees, local dev slots, shared QA slots). Pure HTML builders are
// exported for tests; everything that touches the DOM lives in initWork().
// All text from Jira, git or a QA server goes through esc().

import { api } from './api.js';
import { esc, relTime } from './format.js';

const DAY = 86_400_000;
const SITTING_DAYS = 3; // a ticket this long in one status gets a "sitting" marker

// ---------------------------------------------------------------------------
// Small pieces

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const days = (d) => (d < 1 ? `${Math.max(1, Math.round(d * 24))} h` : `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)} d`);
const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? p;
const copyBtn = (cmd, label, what = 'command') => (cmd ? `<button class="btn small" data-w-copy="${esc(cmd)}" data-w-what="${esc(what)}" title="${esc(cmd)}">${esc(label)}</button>` : '');

const DEV_STATE = {
  running: { icon: '●', word: 'Running', cls: 'ok' },
  claimed: { icon: '◐', word: 'Claimed', cls: 'busy' },
  stale: { icon: '⚠', word: 'Stale lock', cls: 'warn' },
  free: { icon: '○', word: 'Free', cls: 'free' },
};
const QA_STATE = {
  up: { icon: '●', word: 'Up', cls: 'ok' },
  down: { icon: '✕', word: 'Down', cls: 'warn' },
  unknown: { icon: '○', word: 'Not checked', cls: 'free' },
};
const pill = (s) => `<span class="w-pill ${s.cls}"><span aria-hidden="true">${s.icon}</span> ${esc(s.word)}</span>`;

/** Things worth a second look about one worktree, given its ticket's board status. */
export function worktreeHints(w, ticket, now = Date.now()) {
  const out = [];
  const dirty = (w.changed ?? 0) + (w.untracked ?? 0);
  if (w.prunable) out.push('The folder is gone; prune it');
  if (w.conflicts) out.push(`${plural(w.conflicts, 'merge conflict')}`);
  if (ticket?.lane === 'deploy' && dirty) out.push('Ready for deployment, but has uncommitted changes');
  if (ticket?.lane === 'deploy' && w.unpushed) out.push('Ready for deployment, but has unpushed commits');
  if ((ticket?.lane === 'review' || ticket?.lane === 'passed') && w.unpushed) out.push('In review with unpushed commits');
  if (w.behind >= 20) out.push(`${w.behind} commits behind main: rebase or merge soon`);
  const idle = w.lastCommitAt ? (now - Date.parse(w.lastCommitAt)) / DAY : null;
  if (!w.main && idle !== null && idle >= 14) out.push(`No commit in ${Math.floor(idle)} days${dirty ? ', with uncommitted work' : ''}`);
  if (!w.main && w.ticket && !ticket) out.push('Ticket is not on the board (done, or in another status)');
  return out;
}

// ---------------------------------------------------------------------------
// Board

function linkBadges(key, links, start) {
  const l = links?.[key];
  const out = [];
  for (const w of l?.worktrees ?? []) out.push(`<span class="w-badge" title="Worktree ${esc(w.path)} on ${esc(w.branch ?? 'no branch')}"><span aria-hidden="true">⎇</span> ${esc(base(w.path))}${w.dirty ? ` · ${plural(w.dirty, 'change')}` : ''}</span>`);
  for (const s of l?.dev ?? []) out.push(`<span class="w-badge dev" title="${esc(s.label)} is ${esc(s.state)}"><span aria-hidden="true">▶</span> ${esc(s.label)}</span>`);
  for (const s of l?.qa ?? []) out.push(`<span class="w-badge qa" title="${s.how === 'deployed' ? 'Deployed on' : 'Claimed'} ${esc(s.label)}"><span aria-hidden="true">${s.how === 'deployed' ? '✓' : '◐'}</span> ${esc(s.label)}${s.how === 'claimed' ? ' (claimed)' : ''}</span>`);
  if (!l?.worktrees?.length && start?.[key]) out.push(copyBtn(start[key], 'Copy “new worktree”', 'new worktree command'));
  return out.length ? `<div class="w-badges">${out.join('')}</div>` : '';
}

function cardHTML(c, b) {
  const sitting = c.daysInStatus !== null && c.daysInStatus >= SITTING_DAYS;
  const meta = [c.type, c.priority && c.priority !== 'Medium' ? `${c.priority} priority` : null, b.settings.scope !== 'mine' ? (c.assignee ?? 'Unassigned') : null].filter(Boolean).map(esc);
  const age = c.daysInStatus === null ? '' : `<span class="${sitting ? 'w-sitting' : 'w-age'}" title="In “${esc(c.status)}” since ${esc(new Date(c.sinceAt).toLocaleString())}">${sitting ? '<span aria-hidden="true">⏳</span> ' : ''}${days(c.daysInStatus)} in status</span>`;
  const status = b.lanes.find((l) => l.id === c.lane)?.label !== c.status ? `<span class="w-status">${esc(c.status)}</span>` : '';
  return `<article class="tcard" aria-label="${esc(c.key)}: ${esc(c.summary)}">
    <div class="tcard-top"><a class="tkey" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.key)}</a>${status}${age}</div>
    <div class="tsum">${esc(c.summary)}</div>
    ${meta.length || c.fixVersions.length ? `<div class="tmeta">${meta.join(' · ')}${c.fixVersions.map((v) => `<span class="chip">${esc(v)}</span>`).join('')}</div>` : ''}
    ${linkBadges(c.key, b.links, b.start)}
  </article>`;
}

const SCOPE_WORDS = { mine: 'assigned to you', projects: 'in your projects', jql: 'from your filter' };

export function boardHTML(b, ui = {}) {
  if (!b) return '<div class="page-head"><h1>Board</h1><span class="sub">Loading…</span></div>';
  const head = `<div class="page-head"><h1>Board</h1><span class="sub">${b.connected ? `${plural(b.total, 'ticket')} ${SCOPE_WORDS[b.settings.scope]}` : 'Jira is not connected'}${b.refreshedAt ? ` · updated ${esc(relTime(b.refreshedAt))}` : ''}</span>
    <span class="w-actions"><button class="btn small" data-w="board-refresh"${ui.busy ? ' disabled' : ''}>⟳ Refresh</button><button class="btn small" data-w="board-settings" aria-expanded="${!!ui.settingsOpen}">Lanes &amp; filter</button></span></div>`;
  const settings = ui.settingsOpen ? boardSettingsHTML(ui.draft ?? b.settings, ui.msg) : '';
  if (!b.connected) {
    return head + settings + '<div class="empty"><div class="big">🗂</div><h2>Connect Jira to see your board</h2><div>The board shows your Jira tickets in delivery lanes: In Progress, In Code Review, Code Review Pass and Ready for Deployment.</div><button class="btn primary" data-setup>Connect Jira →</button></div>';
  }
  const err = b.error ? `<div class="w-error" role="alert"><b>Couldn’t load the board.</b> ${esc(b.error)}</div>` : '';
  const trunc = b.truncated ? '<div class="w-note">Showing the 300 most recently updated tickets. Narrow the filter to see the rest.</div>' : '';
  const lanes = b.lanes.map((l) => `<section class="lane" aria-label="${esc(l.label)}, ${plural(l.cards.length, 'ticket')}">
      <header class="lane-head" title="Jira statuses: ${esc(l.statuses.join(', '))}"><span>${esc(l.label)}</span><span class="lane-n">${l.cards.length}</span></header>
      <div class="lane-cards">${l.cards.map((c) => cardHTML(c, b)).join('') || '<div class="lane-empty">Nothing here</div>'}</div>
    </section>`).join('');
  return `${head}${settings}${err}${trunc}<div class="board" style="--lanes:${b.lanes.length}">${lanes}</div>
    <p class="w-foot">Read-only: Birddog never moves a ticket. Each card shows how long it has been in its status${b.repo ? `, its worktree in <code>${esc(b.repo)}</code>` : ''} and the dev and QA slots it is on.</p>`;
}

export function boardSettingsHTML(s, msg) {
  const scope = (v, label) => `<label class="w-radio"><input type="radio" name="w-scope" value="${v}" data-wb="scope"${s.scope === v ? ' checked' : ''}> ${label}</label>`;
  const lanes = s.lanes.map((l, i) => `<div class="w-lane-row" data-lane="${i}">
      <label>Lane ${i + 1}<input data-wb="lane-label" data-i="${i}" value="${esc(l.label)}" maxlength="40" aria-label="Lane ${i + 1} name"></label>
      <label class="grow">Jira statuses (comma-separated)<input data-wb="lane-statuses" data-i="${i}" value="${esc(l.statuses.join(', '))}" aria-label="Lane ${i + 1} Jira statuses"></label>
      <button class="btn small" data-w="lane-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move lane ${i + 1} left">←</button>
      <button class="btn small" data-w="lane-down" data-i="${i}" ${i === s.lanes.length - 1 ? 'disabled' : ''} aria-label="Move lane ${i + 1} right">→</button>
      <button class="btn small" data-w="lane-remove" data-i="${i}" ${s.lanes.length === 1 ? 'disabled' : ''} aria-label="Remove lane ${i + 1}">✕</button>
    </div>`).join('');
  return `<div role="group" class="w-settings" data-w-form="board">
    <fieldset><legend>Whose tickets</legend>${scope('mine', 'Assigned to me')}${scope('projects', 'Everyone’s in projects')}${scope('jql', 'My own JQL filter')}
      ${s.scope === 'projects' ? `<label>Project keys<input data-wb="projects" value="${esc(s.projects.join(', '))}" placeholder="PROJ, DBA"></label>` : ''}
      ${s.scope === 'jql' ? `<label>JQL filter (no ORDER BY)<input data-wb="jql" value="${esc(s.jql)}" placeholder="project = PROJ AND sprint in openSprints()"></label>` : ''}
    </fieldset>
    <fieldset><legend>Lanes, left to right</legend>${lanes}<button class="btn small" data-w="lane-add" ${s.lanes.length >= 8 ? 'disabled' : ''}>+ Add a lane</button></fieldset>
    ${msg ? `<div class="w-msg ${msg.ok ? 'ok' : 'bad'}" role="status">${esc(msg.text)}</div>` : ''}
    <div class="w-row"><button class="btn primary" data-w="board-save">Save</button><button class="btn" data-w="board-cancel">Cancel</button><button class="btn" data-w="board-reset" title="Back to In Progress, In Code Review, Code Review Pass, Ready for Deployment">Reset to defaults</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Worktrees & slots

function ticketChip(key, tickets) {
  if (!key) return '<span class="faint">no ticket</span>';
  const t = tickets?.[key];
  return t ? `<a class="tkey" href="${esc(t.url)}" target="_blank" rel="noopener" title="${esc(t.summary)}">${esc(key)}</a> <span class="w-status">${esc(t.laneLabel)}</span>` : `<span class="tkey">${esc(key)}</span>`;
}

function claimForm(kind, id, ws, msg) {
  const opts = ws.repos.flatMap((r) => r.worktrees).map((w) => `<option value="${esc(w.display)}">${esc(base(w.path))}${w.branch ? ` (${esc(w.branch)})` : ''}</option>`).join('');
  return `<div role="group" class="w-claim" data-w-form="claim" data-kind="${kind}" data-id="${esc(id)}">
    ${kind === 'dev' ? `<label>Worktree<select data-wc="worktree"><option value="">(none)</option>${opts}</select></label>` : `<label>Who has it<input data-wc="owner" maxlength="60" placeholder="Your name"></label>`}
    <label>Ticket<input data-wc="ticket" placeholder="PROJ-123" maxlength="40"></label>
    <label class="grow">Note<input data-wc="note" maxlength="200" placeholder="${kind === 'dev' ? 'What you are checking' : 'Regression run, until 3 pm…'}"></label>
    ${msg ? `<div class="w-msg bad" role="status">${esc(msg)}</div>` : ''}
    <div class="w-row"><button class="btn primary small" data-w="claim-save">Claim</button><button class="btn small" data-w="claim-cancel">Cancel</button></div>
  </div>`;
}

function devSlotHTML(s, ws, ui) {
  const st = DEV_STATE[s.state] ?? DEV_STATE.free;
  const open = ui.claim?.kind === 'dev' && ui.claim.id === s.id;
  const from = s.from ? `<span class="faint">from ${esc(s.from)}</span>` : '';
  return `<div class="slot ${st.cls}" aria-label="${esc(s.label)}: ${esc(st.word)}">
    <div class="slot-top"><b>${esc(s.label)}</b>${pill(st)}${from}</div>
    <div class="slot-body">
      <div>${ticketChip(s.ticket, ws.tickets)}</div>
      ${s.worktree ? `<div class="mono" title="${esc(s.worktree)}">⎇ ${esc(base(s.worktree))}${s.branch ? ` · ${esc(s.branch)}` : ''}</div>` : ''}
      ${s.claim?.note ? `<div class="faint">“${esc(s.claim.note)}”</div>` : ''}
      ${s.ports.length ? `<div class="faint">Ports ${s.ports.map((p) => esc(p)).join(', ')}${s.listening ? ` · ${s.listening} listening` : ''}</div>` : '<div class="faint">No ports set</div>'}
      ${s.state === 'stale' ? `<div class="w-msg bad">The lock file names processes that have stopped. Delete <code>${esc(s.lockFile)}</code> if the slot is free.</div>` : ''}
    </div>
    <div class="w-row">${s.url && s.state === 'running' ? `<a class="btn small" href="${esc(s.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
      ${s.claim ? `<button class="btn small" data-w="release" data-kind="dev" data-id="${esc(s.id)}">Release</button>` : `<button class="btn small" data-w="claim" data-kind="dev" data-id="${esc(s.id)}">Claim…</button>`}</div>
    ${open ? claimForm('dev', s.id, ws, ui.claimMsg) : ''}
  </div>`;
}

function qaSlotHTML(s, ws, ui) {
  const st = QA_STATE[s.state] ?? QA_STATE.unknown;
  const open = ui.claim?.kind === 'qa' && ui.claim.id === String(s.n);
  const deployed = s.branch ? `<div class="mono" title="${esc(s.branch)}${s.sha ? ` @ ${esc(s.sha)}` : ''}">${s.deployedTicket ? ticketChip(s.deployedTicket, ws.tickets) : esc(s.branch)}</div>` : '';
  const build = [s.build ? `build ${esc(s.build)}` : null, s.deployedAt && Date.parse(s.deployedAt) ? esc(relTime(s.deployedAt)) : null].filter(Boolean).join(' · ');
  return `<div class="slot qa ${st.cls}${s.claim ? ' claimed' : ''}" aria-label="${esc(s.label)}: ${esc(st.word)}${s.claim ? `, claimed by ${esc(s.claim.owner ?? 'someone')}` : ''}">
    <div class="slot-top">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.label)}</b></a>` : `<b>${esc(s.label)}</b>`}${pill(st)}</div>
    <div class="slot-body">${deployed}${build ? `<div class="faint">${build}</div>` : ''}${s.error && s.state !== 'up' ? `<div class="faint">${esc(s.error)}</div>` : ''}
      ${s.claim ? `<div class="w-claimed"><span aria-hidden="true">◐</span> ${esc(s.claim.owner ?? 'Claimed')}${s.claim.ticket ? ` · ${esc(s.claim.ticket)}` : ''}${s.claim.note ? ` · “${esc(s.claim.note)}”` : ''}</div>` : ''}</div>
    <div class="w-row">${s.claim ? `<button class="btn small" data-w="release" data-kind="qa" data-id="${s.n}">Release</button>` : `<button class="btn small" data-w="claim" data-kind="qa" data-id="${s.n}">Claim…</button>`}</div>
    ${open ? claimForm('qa', String(s.n), ws, ui.claimMsg) : ''}
  </div>`;
}

function worktreeRowHTML(w, ws) {
  const t = w.ticket ? ws.tickets?.[w.ticket] : null;
  const hints = worktreeHints(w, t);
  const dirty = (w.changed ?? 0) + (w.untracked ?? 0);
  const ab = w.ahead === null ? '—' : `<span title="Commits ahead of / behind the main branch">↑${w.ahead} ↓${w.behind}</span>`;
  return `<tr>
    <td><div class="mono"><b>${esc(base(w.path))}</b>${w.main ? ' <span class="chip">main checkout</span>' : ''}</div><div class="faint mono" title="${esc(w.display)}">${esc(w.branch ?? (w.detached ? `detached at ${w.head}` : ''))}</div></td>
    <td>${w.main ? '' : ticketChip(w.ticket, ws.tickets)}</td>
    <td>${dirty ? `<span class="w-dirty">${plural(dirty, 'change')}</span>` : '<span class="faint">clean</span>'}${w.unpushed ? `<div class="w-dirty">${w.unpushed} unpushed</div>` : ''}</td>
    <td>${ab}</td>
    <td>${w.lastCommitAt ? esc(relTime(w.lastCommitAt)) : '—'}${w.lastSubject ? `<div class="faint clip" title="${esc(w.lastSubject)}">${esc(w.lastSubject)}</div>` : ''}</td>
    <td>${w.slot ? `<span class="w-badge dev">▶ ${esc(w.slot.label)}</span>` : ''}</td>
    <td class="w-cmds">${copyBtn(w.commands.open, 'Open', 'editor command')}${copyBtn(w.commands.cd, 'cd', 'cd command')}${copyBtn(w.commands.remove, 'Remove…', 'remove command')}${copyBtn(w.commands.prune, 'Prune', 'prune command')}</td>
  </tr>${hints.length || w.error ? `<tr class="w-hint-row"><td colspan="7">${w.error ? `<span class="w-msg bad">${esc(w.error)}</span>` : ''}${hints.map((h) => `<span class="w-hint"><span aria-hidden="true">⚑</span> ${esc(h)}</span>`).join('')}</td></tr>` : ''}`;
}

export function workspaceHTML(ws, ui = {}) {
  if (!ws) return '<div class="page-head"><h1>Worktrees &amp; slots</h1><span class="sub">Loading…</span></div>';
  const wts = ws.repos.flatMap((r) => r.worktrees);
  const running = ws.devSlots.filter((s) => s.state === 'running').length;
  const qaUp = ws.qaSlots.filter((s) => s.state === 'up').length;
  const sub = [plural(wts.filter((w) => !w.main).length, 'worktree'), `${running}/${ws.devSlots.length} dev slots running`, ws.qaSlots.length ? `${ws.qaSlots.filter((s) => s.claim).length}/${ws.qaSlots.length} QA slots claimed` : null].filter(Boolean).join(' · ');
  const head = `<div class="page-head"><h1>Worktrees &amp; slots</h1><span class="sub">${sub}</span>
    <span class="w-actions"><button class="btn small" data-w="ws-refresh"${ui.busy ? ' disabled' : ''}>⟳ Refresh</button><button class="btn small" data-w="ws-settings" aria-expanded="${!!ui.settingsOpen}">Set up slots</button></span></div>`;
  const settings = ui.settingsOpen ? workspaceSettingsHTML(ui.draft ?? ws.settings, ui.msg) : '';
  const warn = ws.warnings?.length ? `<div class="w-error" role="alert">${ws.warnings.map(esc).join('<br>')}</div>` : '';

  const dev = `<section class="w-section" aria-labelledby="w-dev"><h2 id="w-dev">Dev slots <span class="faint">on this machine</span></h2>
    <div class="slots">${ws.devSlots.map((s) => devSlotHTML(s, ws, ui)).join('') || '<div class="faint">No dev slots. Add some in “Set up slots”.</div>'}</div></section>`;
  const qa = ws.qaSlots.length
    ? `<section class="w-section" aria-labelledby="w-qa"><h2 id="w-qa">QA slots ${qaUp ? `<span class="faint">${qaUp} answering</span>` : ''}</h2>
      <div class="slots qa-grid">${ws.qaSlots.map((s) => qaSlotHTML(s, ws, ui)).join('')}</div>
      <p class="w-foot">${ws.settings.qa.versionPath ? `Birddog asks each slot’s <code>${esc(ws.settings.qa.versionPath)}</code> which branch it runs, once a minute at most.` : 'Add a version path in “Set up slots” and Birddog shows which branch each slot runs.'} Claims are notes on this machine, not a lock your team sees.</p></section>`
    : '<section class="w-section"><h2>QA slots</h2><div class="faint">No QA slots yet. In “Set up slots”, enter how many there are (say 12) and their address pattern.</div></section>';
  const repos = ws.repos.length ? ws.repos.map((r) => `<section class="w-section" aria-label="Worktrees of ${esc(r.name)}"><h2>${esc(r.name)} <span class="faint mono">${esc(r.display)}${r.base ? ` · compared with ${esc(r.base)}` : ''}</span></h2>
      <div class="w-table-wrap"><table class="w-table"><thead><tr><th>Worktree</th><th>Ticket</th><th>Changes</th><th>vs main</th><th>Last commit</th><th>Slot</th><th><span class="sr">Commands</span></th></tr></thead>
      <tbody>${r.worktrees.map((w) => worktreeRowHTML(w, ws)).join('')}</tbody></table></div></section>`).join('')
    : `<section class="w-section"><h2>Worktrees</h2><div class="faint">${ws.settings.repos.length ? 'None of the repos in “Set up slots” could be read.' : 'No repos with worktrees found in your git scan folders. Add your main checkout in “Set up slots”.'}</div></section>`;
  return `${head}${settings}${warn}${dev}${qa}${repos}<p class="w-foot">Birddog only reads your repos. Buttons copy the git command for you to run.</p>`;
}

export function workspaceSettingsHTML(s, msg) {
  const devRows = s.devSlots.map((d, i) => `<div class="w-lane-row">
      <label>Name<input data-ws="dev-label" data-i="${i}" value="${esc(d.label)}" maxlength="30"></label>
      <label>Ports<input data-ws="dev-ports" data-i="${i}" value="${esc(d.ports.join(', '))}" placeholder="5173, 5001"></label>
      <label class="grow">Lock file (optional)<input data-ws="dev-lock" data-i="${i}" value="${esc(d.lockFile)}" placeholder="~/code/.slot-${i + 1}.lock"></label>
      <button class="btn small" data-w="dev-remove" data-i="${i}" aria-label="Remove ${esc(d.label)}">✕</button>
    </div>`).join('');
  return `<div role="group" class="w-settings" data-w-form="ws">
    <fieldset><legend>Repos</legend>
      <label>Main checkouts, one per line (empty: every repo with worktrees in your git scan folders)<textarea data-ws="repos" rows="2">${esc(s.repos.join('\n'))}</textarea></label>
      <div class="w-row"><label>Ticket pattern<input data-ws="ticketPattern" value="${esc(s.ticketPattern)}"></label><label>New branch prefix<input data-ws="branchPrefix" value="${esc(s.branchPrefix)}"></label></div>
    </fieldset>
    <fieldset><legend>Dev slots on this machine</legend>${devRows}<button class="btn small" data-w="dev-add" ${s.devSlots.length >= 12 ? 'disabled' : ''}>+ Add a dev slot</button></fieldset>
    <fieldset><legend>QA slots</legend><div class="w-row">
      <label>How many<input type="number" min="0" max="40" data-ws="qa-count" value="${esc(s.qa.count)}"></label>
      <label>Name<input data-ws="qa-label" value="${esc(s.qa.label)}"></label>
      <label class="grow">Address pattern<input data-ws="qa-pattern" value="${esc(s.qa.pattern)}" placeholder="https://qa{n}.example.com"></label>
      <label>Version path<input data-ws="qa-versionPath" value="${esc(s.qa.versionPath)}" placeholder="/api/version"></label></div>
      <div class="faint">{n} is the slot number ({nn} pads it: 07). The version path should answer JSON with the branch (and, if it has them, commit and build).</div>
    </fieldset>
    ${msg ? `<div class="w-msg ${msg.ok ? 'ok' : 'bad'}" role="status">${esc(msg.text)}</div>` : ''}
    <div class="w-row"><button class="btn primary" data-w="ws-save">Save</button><button class="btn" data-w="ws-cancel">Cancel</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Wiring (browser only)

const clone = (o) => JSON.parse(JSON.stringify(o));

export function initWork({ root, currentView, copy }) {
  const ui = { board: null, ws: null, b: {}, w: {} };

  const paint = () => {
    const v = currentView();
    if (v === 'board') root().innerHTML = boardHTML(ui.board, ui.b);
    else if (v === 'worktrees') root().innerHTML = workspaceHTML(ui.ws, ui.w);
  };
  async function load(which, fresh = false) {
    const side = which === 'board' ? ui.b : ui.w;
    side.busy = true; paint();
    try {
      if (which === 'board') ui.board = await api.board(fresh);
      else ui.ws = await api.workspace(fresh);
    } catch (e) {
      if (which === 'board') ui.board ??= { connected: true, settings: { scope: 'mine', lanes: [] }, lanes: [], total: 0, links: {}, start: {} };
      if (which === 'board') ui.board.error = e.message; else ui.ws ??= { settings: { repos: [], devSlots: [], qa: {} }, repos: [], devSlots: [], qaSlots: [], warnings: [e.message] };
    }
    side.busy = false; paint();
  }

  /** Read the open settings form back into the draft (inputs keep what people typed). */
  function readBoardForm() {
    const d = ui.b.draft;
    const f = root().querySelector('[data-w-form="board"]');
    if (!f || !d) return;
    d.scope = f.querySelector('[data-wb="scope"]:checked')?.value ?? d.scope;
    const p = f.querySelector('[data-wb="projects"]'); if (p) d.projects = p.value.split(/[\s,]+/).filter(Boolean);
    const j = f.querySelector('[data-wb="jql"]'); if (j) d.jql = j.value;
    f.querySelectorAll('[data-wb="lane-label"]').forEach((el) => { d.lanes[+el.dataset.i].label = el.value; });
    f.querySelectorAll('[data-wb="lane-statuses"]').forEach((el) => { d.lanes[+el.dataset.i].statuses = el.value.split(',').map((x) => x.trim()).filter(Boolean); });
  }
  function readWsForm() {
    const d = ui.w.draft;
    const f = root().querySelector('[data-w-form="ws"]');
    if (!f || !d) return;
    const val = (k) => f.querySelector(`[data-ws="${k}"]`)?.value ?? '';
    d.repos = val('repos').split('\n').map((x) => x.trim()).filter(Boolean);
    d.ticketPattern = val('ticketPattern');
    d.branchPrefix = val('branchPrefix');
    f.querySelectorAll('[data-ws="dev-label"]').forEach((el) => { d.devSlots[+el.dataset.i].label = el.value; });
    f.querySelectorAll('[data-ws="dev-ports"]').forEach((el) => { d.devSlots[+el.dataset.i].ports = el.value.split(/[\s,]+/).filter(Boolean).map(Number); });
    f.querySelectorAll('[data-ws="dev-lock"]').forEach((el) => { d.devSlots[+el.dataset.i].lockFile = el.value; });
    d.qa = { count: Number(val('qa-count') || 0), label: val('qa-label'), pattern: val('qa-pattern'), versionPath: val('qa-versionPath') };
  }

  async function act(a, t) {
    const i = Number(t.dataset.i);
    switch (a) {
      case 'board-refresh': return load('board', true);
      case 'ws-refresh': return load('worktrees', true);
      case 'board-settings':
        ui.b.settingsOpen = !ui.b.settingsOpen; ui.b.draft = ui.b.settingsOpen && ui.board ? clone(ui.board.settings) : null; ui.b.msg = null; return paint();
      case 'board-cancel': ui.b.settingsOpen = false; ui.b.draft = null; return paint();
      case 'lane-add': readBoardForm(); ui.b.draft.lanes.push({ label: '', statuses: [] }); return paint();
      case 'lane-remove': readBoardForm(); ui.b.draft.lanes.splice(i, 1); return paint();
      case 'lane-up': case 'lane-down': {
        readBoardForm();
        const l = ui.b.draft.lanes; const j = a === 'lane-up' ? i - 1 : i + 1;
        [l[i], l[j]] = [l[j], l[i]]; return paint();
      }
      case 'board-save': case 'board-reset': {
        if (a === 'board-save') readBoardForm();
        try {
          const lanes = ui.b.draft.lanes.map(({ id, label, statuses }) => ({ ...(id ? { id } : {}), label, statuses }));
          ui.board = a === 'board-save' ? await api.boardSettings({ ...ui.b.draft, lanes }) : await api.boardReset();
          ui.b = { settingsOpen: false };
        } catch (e) { ui.b.msg = { ok: false, text: e.message }; }
        return paint();
      }
      case 'ws-settings':
        ui.w.settingsOpen = !ui.w.settingsOpen; ui.w.draft = ui.w.settingsOpen && ui.ws ? clone(ui.ws.settings) : null; ui.w.msg = null; return paint();
      case 'ws-cancel': ui.w.settingsOpen = false; ui.w.draft = null; return paint();
      case 'dev-add': readWsForm(); ui.w.draft.devSlots.push({ label: `Dev ${ui.w.draft.devSlots.length + 1}`, ports: [], lockFile: '' }); return paint();
      case 'dev-remove': readWsForm(); ui.w.draft.devSlots.splice(i, 1); return paint();
      case 'ws-save': {
        readWsForm();
        try {
          const devSlots = ui.w.draft.devSlots.map(({ id, label, ports, lockFile }) => ({ ...(id ? { id } : {}), label, ports, lockFile }));
          ui.ws = await api.workspaceSettings({ ...ui.w.draft, devSlots });
          ui.w = { settingsOpen: false };
        } catch (e) { ui.w.msg = { ok: false, text: e.message }; }
        return paint();
      }
      case 'claim': ui.w.claim = { kind: t.dataset.kind, id: t.dataset.id }; ui.w.claimMsg = null; paint(); return root().querySelector('[data-w-form="claim"] select, [data-w-form="claim"] input')?.focus();
      case 'claim-cancel': ui.w.claim = null; return paint();
      case 'claim-save': {
        const f = t.closest('[data-w-form="claim"]');
        const body = Object.fromEntries([...f.querySelectorAll('[data-wc]')].map((el) => [el.dataset.wc, el.value.trim()]));
        try { ui.ws = await api.claimSlot(f.dataset.kind, f.dataset.id, body); ui.w.claim = null; } catch (e) { ui.w.claimMsg = e.message; }
        return paint();
      }
      case 'release':
        try { ui.ws = await api.releaseSlot(t.dataset.kind, t.dataset.id); } catch (e) { ui.w.claimMsg = e.message; }
        return paint();
      default: return undefined;
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-w],[data-w-copy]');
    if (!t || !root().contains(t)) return;
    e.preventDefault();
    if (t.dataset.wCopy) return copy(t.dataset.wCopy, t.dataset.wWhat ?? 'command');
    act(t.dataset.w, t);
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches?.('[data-wb="scope"]')) { readBoardForm(); paint(); }
  });
  document.addEventListener('keydown', (e) => {
    const f = e.target.closest?.('[data-w-form]');
    if (!f || e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    const btn = f.querySelector(f.dataset.wForm === 'claim' ? '[data-w="claim-save"]' : f.dataset.wForm === 'board' ? '[data-w="board-save"]' : '[data-w="ws-save"]');
    btn?.click();
  });

  return {
    /** Draw a work view (and load its data the first time, or when it's old). */
    render(view) {
      paint();
      const data = view === 'board' ? ui.board : ui.ws;
      const age = data?.refreshedAt ? Date.now() - Date.parse(data.refreshedAt) : Infinity;
      const side = view === 'board' ? ui.b : ui.w;
      if (!side.busy && age > 60_000) load(view);
    },
    refresh(view) { return load(view, true); },
    editing: () => !!(ui.b.settingsOpen || ui.w.settingsOpen || ui.w.claim),
  };
}
