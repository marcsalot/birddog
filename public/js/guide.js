// The user guide: a searchable, collapsible rail on the right (press g).
// Screenshots come from `npm run screenshots`, which runs Birddog in --demo mode,
// so they only ever show made-up data.

import { esc } from './format.js';

const shot = (name, alt) => `<figure class="g-shot"><img data-shot="${name}" alt="${esc(alt)}" loading="lazy" width="640" height="400"><figcaption>${esc(alt)}</figcaption></figure>`;
const keys = (...k) => k.map((x) => `<kbd>${esc(x)}</kbd>`).join(' ');

export const SECTIONS = [
  {
    id: 'start', title: 'Getting started', words: 'start first run setup wizard demo overview inbox what is folder repos no account next step',
    html: `<p>Birddog looks through your local git repos, GitHub, Jira and calendar, and lists what needs you, most urgent first. Every item says <b>why</b> it's there and which rule put it there.</p>
      ${shot('overview', 'The Overview: load dial, open items, meetings and the last 14 days')}
      <p><b>Overview</b> (${keys('0')}) is the front page: how busy you are right now, what has waited longest, and how the last two weeks went. <b>Inbox</b> (${keys('1')}) is the list itself, grouped into <b>Now</b>, <b>Today</b> and <b>Later</b>.</p>
      <p>The first time you open Birddog it asks one thing: <b>where do you keep your code?</b> It has already ticked the folder it found with your repos, so usually you just press <b>Show my work</b>. No account needed.</p>
      ${shot('first-run', 'The first run: one question, with the folder of repos already ticked')}
      <p>Then it suggests one next step, <b>Connect GitHub</b>, above the list. Everything else (Jira, Linear, Slack, calendars and the rest) waits in <b>Sources &amp; settings</b> until you want it. Prefer a tour of every source? ${keys('⌘K')} → <i>Run the setup wizard</i>.</p>
      <p>Just looking? <code>birddog --demo</code> runs on made-up data and never touches your repos, tokens or calendar.</p>`,
  },
  {
    id: 'sources', title: 'Sources', words: 'git github jira calendar ical connect token sign in folders repos stale retry',
    html: `<p>Connect them in <b>Sources &amp; settings</b>. A fresh install starts with local git only. Sources are listed A–Z; type in the search box at the top to find one by name or by what it does (<i>calendar</i>, <i>tickets</i>, <i>ci</i>). ${keys('esc')} clears it.</p>
      <ul>
        <li><b>Local git</b>: pick the folders that hold your code. Birddog finds unpushed commits, uncommitted work and branches to tidy. It never changes your repos.</li>
        <li><b>GitHub</b>: <i>Use my gh CLI login</i> is the quickest way in. You get review requests, your PRs with failing checks or change requests, @mentions and assigned issues.</li>
        <li><b>Jira Cloud</b>: your site, your email and an API token. You get your tickets, ranked by due date, sprint end, blockers and priority.</li>
        <li><b>Calendar</b>: paste a private iCal link (Google, Outlook, iCloud) or choose an <code>.ics</code> file. You get meetings starting soon and later today.</li>
      </ul>
      <p>Tokens and private links go to your OS keychain, never to config.json. If a source fails, its last good items stay, marked <b>stale</b>, with a <b>Retry</b> button.</p>`,
  },
  {
    id: 'more', title: 'More sources (GitLab, Linear, Azure DevOps, Sentry, PagerDuty, Slack)', words: 'gitlab linear azure devops boards repos sentry pagerduty on call incident slack dm mention actions ci dependabot security token',
    html: `<p>Switch these on in <b>Sources &amp; settings</b> when you use them. Each one asks for the smallest read-only access that works, and keeps its token in your keychain.</p>
      <ul>
        <li><b>GitLab</b>: merge requests waiting for your review, your MRs with a failed pipeline or conflicts, and issues assigned to you. Use <i>Sign in with GitLab</i> (needs an application with the <code>read_api</code> scope) or a personal access token with <code>read_api</code>. Self-managed GitLab works too.</li>
        <li><b>Linear</b>: your open issues, ranked by due date, cycle end, blockers and priority. Needs a personal API key.</li>
        <li><b>Azure DevOps</b>: pull requests you haven't voted on yet, and work items assigned to you. Needs a personal access token with <i>Work Items: Read</i> and <i>Code: Read</i>.</li>
        <li><b>Sentry</b>: unresolved errors assigned to you, with regressed and new ones first. Needs an auth token with <code>event:read</code> and <code>org:read</code>.</li>
        <li><b>PagerDuty</b>: incidents paged to you (triggered ones are <b>Now</b>), and when you're on call. Needs a user API token.</li>
        <li><b>Slack</b>: messages that mention you, and DMs waiting for your reply. Needs a user token (<code>xoxp-…</code>) from your own Slack app, with <code>search:read</code>, <code>im:read</code>, <code>im:history</code> and <code>users:read</code>.</li>
        <li><b>GitHub</b> also shows <b>failing Actions runs</b> on branches you pushed this week, and <b>Dependabot alerts</b> on those repos. Turn them off with <code>"actions": false</code> or <code>"security": false</code> under <code>sources.github</code>.</li>
      </ul>
      <p>In Docker, pass the tokens as <code>GITLAB_TOKEN</code>, <code>LINEAR_API_KEY</code>, <code>AZURE_DEVOPS_EXT_PAT</code>, <code>SENTRY_AUTH_TOKEN</code>, <code>BIRDDOG_PAGERDUTY_TOKEN</code> or <code>BIRDDOG_SLACK_TOKEN</code>.</p>`,
  },
  {
    id: 'logins', title: 'Sign-ins (GitHub, Google, Microsoft, GitLab, Linear, PagerDuty, iCloud)', words: 'oauth login sign in google microsoft outlook office 365 atlassian jira gitlab linear pagerduty icloud apple caldav app-specific password client id register unverified own app',
    html: `<p>Where a card shows <b>Sign in with …</b>, one click is all it takes: Birddog uses its own app for that provider, so there's nothing to register. The line next to the button says what Birddog will read. It only ever reads, and the tokens stay in your keychain. After you sign in, the card shows the account and a <b>Disconnect</b> button.</p>
      <ul>
        <li><b>GitHub</b>: a code to approve on github.com (device flow), or your <code>gh</code> login.</li>
        <li><b>Google Calendar</b> and <b>Microsoft 365 / Outlook</b>: read-only calendar access.</li>
        <li><b>GitLab</b> (gitlab.com), <b>Linear</b> and <b>PagerDuty</b>: read-only access, as an alternative to a token.</li>
        <li><b>Jira</b> and <b>Slack</b> use tokens. Their sign-in needs a secret that a downloadable app can't keep, so there's no one-click app for them.</li>
        <li><b>iCloud</b>: Apple has no sign-in for calendars. Make an <b>app-specific password</b> at appleid.apple.com → Sign-In and Security → App-Specific Passwords, then choose <i>iCloud</i> on the Calendar card.</li>
      </ul>
      <p><b>About Google sign-in.</b> Birddog's Google app is still <b>in testing</b>, so for now it's <b>invite-only</b>: Google only lets in accounts the maintainer has added as test users. Anyone else sees <b>“access denied”</b> or <b>“has not completed verification”</b>, and Birddog says so. Use your calendar's private <b>iCal link</b> instead; that needs no Google sign-in. If you are a test user, Google shows an <b>“unverified app”</b> screen (choose <b>Continue</b>, or <b>Advanced → Go to Birddog (unsafe)</b>), and it ends the sign-in after <b>7 days</b>, so expect <b>Sign in again</b> about once a week. Birddog only reads your calendar events, read-only, and they stay on this computer. Once the app is published but not yet verified, anyone can sign in through the warning screen, up to 100 accounts in all; once Google verifies it, the warning goes away.</p>
      <p><b>“One more step”</b> on the Calendar card: Birddog's Google app also needs its secret, which doesn't ship with Birddog. Ask whoever runs the Birddog Google project for it, then run <code>birddog secret set google-client-secret</code> and paste it at the prompt. It isn't shown as you paste, it never goes on the command line (so it stays out of your shell history), and it's kept in your keychain. You can also set <code>BIRDDOG_GOOGLE_CLIENT_SECRET</code>, or <code>BIRDDOG_GOOGLE_CLIENT_SECRET_FILE</code> pointing at a file, and restart Birddog. Reload the page and the <b>Sign in with Google</b> button appears. No secret? The iCal link works right away.</p>
      <p>If a sign-in can't be renewed (you revoked it, or it expired), the source turns <b>stale</b> and shows <b>Sign in again</b>.</p>
      <p><b>No sign-in button?</b> This copy of Birddog has no app for that provider yet, so use a token, or bring your own app: register one (see the README) and put its client ID in config.json under <code>oauth.&lt;provider&gt;.clientId</code> or <code>BIRDDOG_&lt;PROVIDER&gt;_CLIENT_ID</code>. Your own app always wins over the built-in one.</p>
      <p>Sign-ins aren't available in Docker, because there's no keychain for the tokens. Use API tokens or iCal links there.</p>
      <p><b>Sign in with Apple</b> for the dashboard itself is an optional login, like Google or Okta login. It needs a paid Apple Developer account, a Services ID and a public https address; see the README.</p>`,
  },
  {
    id: 'triage', title: 'Done, snooze and undo', words: 'triage done snooze undo restore hide comes back change',
    html: `${shot('inbox', 'The inbox with an item open: why it is here, the rule, and the next step')}
      <ul>
        <li>${keys('x')} <b>Done</b> hides an item until it changes. New commits or new activity bring it back.</li>
        <li>${keys('s')} <b>Snooze</b>: then ${keys('1')} one hour, ${keys('2')} tomorrow 9:00, ${keys('3')} next Monday, ${keys('4')} until it changes.</li>
        <li>${keys('z')} <b>Undo</b> right after either one. ${keys('u')} <b>Restore</b> from the Done or Snoozed view.</li>
        <li>${keys('↵')} opens the details: why it's here, the rule that ranked it, and a suggested next step you can copy with ${keys('c')}.</li>
      </ul>
      <p>Done and snooze only change Birddog's own list, never GitHub, Jira or git.</p>`,
  },
  {
    id: 'shortcuts', title: 'Keyboard shortcuts', words: 'keyboard shortcuts keys hotkeys',
    html: `<table class="g-keys"><tbody>
      <tr><td>${keys('j')} ${keys('k')}</td><td>Move down / up</td></tr>
      <tr><td>${keys('↵')}</td><td>Open details</td></tr>
      <tr><td>${keys('x')} ${keys('s')} ${keys('z')} ${keys('u')}</td><td>Done, snooze, undo, restore</td></tr>
      <tr><td>${keys('c')} ${keys('o')}</td><td>Copy the next-step command, open the link</td></tr>
      <tr><td>${keys('0')}</td><td>Overview</td></tr>
      <tr><td>${keys('1')}–${keys('6')}</td><td>All, Now, Today, Later, Snoozed, Done</td></tr>
      <tr><td>${keys('a')}</td><td>Ask Fetch</td></tr>
      <tr><td>${keys('g')}</td><td>This guide</td></tr>
      <tr><td>${keys('⇧G')}</td><td>Widen or narrow this guide (or drag its left edge)</td></tr>
      <tr><td>${keys('m')}</td><td>Show or hide the menu</td></tr>
      <tr><td>${keys('r')}</td><td>Refresh everything</td></tr>
      <tr><td>${keys('/')} ${keys('⌘K')}</td><td>Search and commands</td></tr>
      <tr><td>${keys('t')} ${keys('p')}</td><td>Light / dark, next theme</td></tr>
      <tr><td>${keys('?')}</td><td>All shortcuts at a glance</td></tr>
      <tr><td>${keys('esc')}</td><td>Close whatever is open</td></tr>
    </tbody></table>`,
  },
  {
    id: 'notifications', title: 'Notifications', words: 'notifications desktop alert bell quiet hours snooze all notify system',
    html: `<p>Press 🔔 and switch on <b>Tell me when something needs me now</b>. Birddog then announces each item that becomes <b>Now</b> (a review someone is waiting on, a meeting about to start) and each source that stops working, <b>at most once</b>.</p>
      <ul>
        <li>Notifications show in the browser while a Birddog tab is open, and from the system otherwise. You can pick one.</li>
        <li>Switch sources and kinds on and off, set <b>quiet hours</b>, or <b>snooze all</b> for an hour or until tomorrow.</li>
        <li>No dashboard running? <code>birddog notify</code> keeps the system notifications coming. <code>birddog notify --test</code> checks that your OS lets them through.</li>
      </ul>`,
  },
  {
    id: 'chat', title: 'Ask Fetch (chat)', words: 'chat ask claude anthropic api key question assistant ai',
    html: `${shot('chat', 'Ask Fetch answering "What needs me now?" from the inbox')}
      <p>Press ${keys('a')}, or the ✦ button in the bottom-right corner, and ask in plain words: <i>What needs me now? What's due tomorrow? Which PRs need work?</i> <b>Fetch</b>, Birddog's assistant (the dog that fetches answers), replies from your own items, and can mark things done or snooze them. It always asks you to <b>Confirm</b> first.</p>
      <p><b>Before you turn it on:</b> answers come from Claude, through your own Anthropic API key, and your question plus the items it looks up (titles, "why" lines, fields, links) are sent to Anthropic. It stays off until you add a key and agree to that. <b>Turn off</b> forgets the key.</p>`,
  },
  {
    id: 'docker', title: 'Docker', words: 'docker container compose volume repos env token port loopback',
    html: `<pre><code>docker compose up -d                 # http://127.0.0.1:4747
docker compose --profile demo up     # made-up data, port 4848</code></pre>
      <ul>
        <li>Publish the port on <code>127.0.0.1</code> only. Anything wider shares your work inbox with your network.</li>
        <li>Your code is mounted read-only at <code>/repos</code>. Config and done/snooze state live on the <code>birddog-data</code> volume.</li>
        <li>Tokens come from environment variables or Docker secrets: <code>GITHUB_TOKEN</code>, <code>BIRDDOG_JIRA_TOKEN</code>, <code>BIRDDOG_CAL_URL</code>, <code>ANTHROPIC_API_KEY</code>, or their <code>_FILE</code> versions. They're never written to disk.</li>
        <li>Set <code>TZ</code> so meeting times show in your time zone.</li>
      </ul>`,
  },
  {
    id: 'mcp', title: 'MCP (Claude Code, Claude Desktop)', words: 'mcp claude code desktop tools model context protocol ai',
    html: `<p><code>birddog mcp</code> lets AI tools ask "what needs me?" and triage items. It reads the same data as this dashboard.</p>
      <pre><code>claude mcp add --scope user birddog -- npx -y @marcusferrell/birddog mcp</code></pre>
      <p>Tools: <code>list_items</code>, <code>get_item</code>, <code>list_sources</code>, <code>mark_done</code>, <code>snooze</code>, <code>restore</code>. They never return tokens or settings. For Claude Desktop, add the same command under <code>mcpServers</code> in <code>claude_desktop_config.json</code>.</p>`,
  },
];

let ctx = null; // { save(open), saveWidth(px|null), theme() }
let query = '';

const $ = (s) => document.querySelector(s);
export const guideOpen = () => document.body.classList.contains('guide-open');

export function initGuide(options) {
  ctx = options;
  render();
  setWidth(options.width ?? null, { save: false });
  window.addEventListener('resize', () => { if (width) applyWidth(); });
  if (options.open) setGuide(true, { save: false });
}

function setGuide(open, { save = true, section } = {}) {
  document.body.classList.toggle('guide-open', open);
  $('#guideBtn')?.setAttribute('aria-expanded', String(open));
  $('#guideRail')?.setAttribute('aria-hidden', String(!open));
  if (open) {
    loadShots();
    if (section) {
      const d = document.querySelector(`#guideRail details[data-g="${CSS.escape(section)}"]`);
      if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); }
    }
  }
  if (save) ctx.save(open);
  window.dispatchEvent(new Event('resize')); // charts re-measure
}
export const openGuide = (section) => setGuide(true, { section });
export const closeGuide = () => setGuide(false);
export const toggleGuide = () => setGuide(!guideOpen());

// Width: drag the left edge (or use the arrow keys on it) to any size, or ⇤ / Shift+G
// to jump between the normal rail and a wide reading view. null = the default.
export const GUIDE_DEFAULT = 360;
export const GUIDE_MIN = 300;
const WIDE_AT = 520; // at or above this, the guide counts as "wide"
let width = null;

/** The widest the guide may get: leave the page at least 420px when docked. */
export function maxGuideWidth(viewport = window.innerWidth, rail = railWidth()) {
  return Math.max(GUIDE_MIN, viewport > 1199 ? viewport - rail - 420 : Math.round(viewport * 0.96));
}
const railWidth = () => document.querySelector('#rail')?.getBoundingClientRect().width || 0;
export const clampGuideWidth = (px, max = maxGuideWidth()) => Math.round(Math.min(Math.max(px, GUIDE_MIN), max));
export const wideGuideWidth = (viewport = window.innerWidth) => clampGuideWidth(Math.min(760, viewport * 0.5), maxGuideWidth(viewport));

function applyWidth() {
  const px = width == null ? GUIDE_DEFAULT : clampGuideWidth(width);
  document.body.style.setProperty('--guide-base', `${px}px`);
  document.body.classList.toggle('guide-wide', px >= WIDE_AT);
  const b = $('#guideRail [data-guide="wide"]');
  if (b) {
    const wide = px >= WIDE_AT;
    b.setAttribute('aria-pressed', String(wide));
    b.setAttribute('aria-label', wide ? 'Narrow the guide (Shift+G)' : 'Widen the guide (Shift+G)');
    b.title = `${b.getAttribute('aria-label')}. Or drag its left edge.`;
    b.textContent = wide ? '⇥' : '⇤';
  }
  const h = $('#guideRail .g-resize');
  if (h) { h.setAttribute('aria-valuenow', String(px)); h.setAttribute('aria-valuemax', String(maxGuideWidth())); }
  return px;
}

function setWidth(px, { save = true } = {}) {
  width = px == null ? null : clampGuideWidth(px);
  applyWidth();
  if (save) ctx?.saveWidth?.(width);
  if (guideOpen()) window.dispatchEvent(new Event('resize')); // charts re-measure
}
export const guideWide = () => document.body.classList.contains('guide-wide');
export const toggleGuideWide = () => setWidth(guideWide() ? null : wideGuideWidth());

function startDrag(e) {
  const h = e.target.closest('.g-resize');
  if (!h || e.button !== 0) return;
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  document.body.classList.add('guide-resizing');
  const right = document.querySelector('#guideRail').getBoundingClientRect().right;
  const move = (ev) => { width = clampGuideWidth(right - ev.clientX); applyWidth(); };
  const end = () => {
    h.removeEventListener('pointermove', move);
    document.body.classList.remove('guide-resizing');
    ctx?.saveWidth?.(width);
    window.dispatchEvent(new Event('resize'));
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', end, { once: true });
  h.addEventListener('pointercancel', end, { once: true });
}


/** Open or close every section at once. */
function setAllSections(open) {
  for (const d of document.querySelectorAll('#guideRail details:not([hidden])')) d.open = open;
  syncAllButton();
}
function syncAllButton() {
  const b = $('#guideRail [data-guide="all"]');
  if (!b) return;
  const visible = [...document.querySelectorAll('#guideRail details:not([hidden])')];
  const allOpen = visible.length > 0 && visible.every((d) => d.open);
  b.textContent = allOpen ? 'Collapse all' : 'Expand all';
  b.setAttribute('aria-pressed', String(allOpen));
}

/** Point screenshots at the light or dark set, matching the current theme. */
export function loadShots() {
  const mode = ctx?.theme?.() === 'dark' ? 'dark' : 'light';
  for (const img of document.querySelectorAll('#guideRail img[data-shot]')) {
    const src = `/guide/${img.dataset.shot}-${mode}.jpg`;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  }
}

const plainText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');

/** Sections matching the search, with how many matched. */
export function searchGuide(q, sections = SECTIONS) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections.map((s) => s.id);
  return sections.filter((s) => {
    const hay = `${s.title} ${s.words} ${plainText(s.html)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).map((s) => s.id);
}

function render() {
  const el = $('#guideRail');
  if (!el) return;
  el.innerHTML = `<div class="g-resize" role="separator" aria-orientation="vertical" aria-label="Resize the guide: drag, or use the arrow keys. Double-click to reset." title="Drag to resize · double-click to reset" tabindex="0" aria-valuemin="${GUIDE_MIN}" aria-valuenow="${GUIDE_DEFAULT}"></div><header><b>Guide</b><span class="g-tools"><button class="g-all" data-guide="all" aria-pressed="false">Expand all</button><button class="icon-btn" data-guide="wide" aria-pressed="false" aria-label="Widen the guide (Shift+G)" title="Widen the guide (Shift+G)">⇤</button><button class="icon-btn" data-guide="close" aria-label="Close the guide (g)" title="Close the guide (g)">✕</button></span></header>
    <div class="g-search"><input id="guideSearch" type="search" placeholder="Search the guide…" aria-label="Search the guide" autocomplete="off" spellcheck="false"><span id="guideCount" aria-live="polite"></span></div>
    <div class="g-body">${SECTIONS.map((s, i) => `<details data-g="${s.id}" ${i === 0 ? 'open' : ''}><summary>${esc(s.title)}</summary><div class="g-sec">${s.html}</div></details>`).join('')}
      <p class="g-none" hidden>Nothing in the guide matches that. Try fewer words, or the README on GitHub.</p></div>`;
}

function applySearch() {
  const ids = new Set(searchGuide(query));
  let shown = 0;
  for (const d of document.querySelectorAll('#guideRail details')) {
    const on = ids.has(d.dataset.g);
    d.hidden = !on;
    if (on) shown++;
    if (query) d.open = on;
  }
  $('#guideRail .g-none').hidden = shown > 0;
  $('#guideCount').textContent = query ? `${shown} of ${SECTIONS.length}` : '';
  syncAllButton();
}

export function onGuideEvent(e) {
  if (!e.target.closest?.('#guideRail')) return false;
  if (e.type === 'input' && e.target.id === 'guideSearch') { query = e.target.value.trim(); applySearch(); return true; }
  if (e.type === 'keydown' && e.key === 'Escape') { if (query) { e.target.value = ''; query = ''; applySearch(); } else closeGuide(); return true; }
  if (e.type === 'click' && e.target.closest('[data-guide="close"]')) { closeGuide(); return true; }
  if (e.type === 'click' && e.target.closest('[data-guide="wide"]')) { toggleGuideWide(); return true; }
  if (e.type === 'pointerdown' && e.target.closest('.g-resize')) { startDrag(e); return true; }
  if (e.type === 'dblclick' && e.target.closest('.g-resize')) { setWidth(null); return true; }
  if (e.type === 'keydown' && e.target.closest('.g-resize') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const now = width ?? GUIDE_DEFAULT, step = e.shiftKey ? 80 : 24;
    setWidth({ ArrowLeft: now + step, ArrowRight: now - step, Home: GUIDE_MIN, End: maxGuideWidth() }[e.key]);
    return true;
  }
  if (e.type === 'click' && e.target.closest('[data-guide="all"]')) { setAllSections(e.target.closest('[data-guide="all"]').getAttribute('aria-pressed') !== 'true'); return true; }
  if (e.type === 'click' && e.target.closest('summary')) { setTimeout(syncAllButton); return false; }
  return false;
}
