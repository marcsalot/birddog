// The board and worktrees/slots over HTTP, and in the demo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDemo } from '../src/demo.mjs';
import { createSecretStore } from '../src/secrets.mjs';
import { createBirddog } from '../src/server.mjs';
import { boardHTML, workspaceHTML, worktreeHints } from '../public/js/work.js';
import { tmpDir } from './helpers.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function client(port) {
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
}

describe('board and workspace API', () => {
  let app; let api; let dir;
  before(async () => {
    dir = await tmpDir();
    app = await createBirddog({
      dir, sources: [], autoRefresh: false, log: quiet, secrets: await createSecretStore({ dir, backend: 'file' }),
      workspaceGit: { findRepos: async () => [], worktrees: async () => [], base: async () => null, inspect: async () => ({}), readFile: async () => '' },
      workspaceProbe: async () => false,
    });
    api = client(await app.start(0));
  });
  after(() => app.close());

  it('GET /api/board without Jira says so, with the default lanes', async () => {
    const r = await api('/api/board');
    assert.equal(r.status, 200);
    assert.equal(r.json.connected, false);
    assert.deepEqual(r.json.lanes.map((l) => l.label), ['In Progress', 'In Code Review', 'Code Review Pass', 'Ready for Deployment']);
    assert.deepEqual(r.json.links, {});
  });

  it('saves board settings to config.json, refuses bad ones, and resets', async () => {
    let r = await api('/api/board/settings', { method: 'PUT', body: { scope: 'projects', projects: 'proj', lanes: [{ label: 'Doing', statuses: 'In Progress' }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.settings.lanes, [{ id: 'doing', label: 'Doing', statuses: ['In Progress'] }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(app.configFile, 'utf8')).board.projects, ['PROJ']);
    r = await api('/api/board/settings', { method: 'PUT', body: { lanes: [] } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least one lane/);
    r = await api('/api/board/settings', { method: 'DELETE', body: {} });
    assert.equal(r.json.settings.lanes.length, 4);
    assert.equal(JSON.parse(fs.readFileSync(app.configFile, 'utf8')).board, undefined);
  });

  it('saves workspace settings and claims slots', async () => {
    let r = await api('/api/workspace/settings', { method: 'PUT', body: { qa: { count: 12, pattern: 'https://qa{n}.example.com' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.qaSlots.length, 12);
    assert.deepEqual(r.json.tickets, {});
    r = await api('/api/workspace/slots/qa/12', { method: 'PUT', body: { owner: 'Sam', ticket: 'PROJ-4' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.qaSlots[11].claim.owner, 'Sam');
    assert.deepEqual(r.json.links['PROJ-4'].qa, [{ n: 12, label: 'QA 12', how: 'claimed' }]);
    r = await api('/api/workspace/slots/dev/dev1', { method: 'PUT', body: { ticket: 'PROJ-4' } });
    assert.equal(r.json.devSlots[0].state, 'claimed');
    r = await api('/api/workspace/slots/qa/12', { method: 'DELETE', body: {} });
    assert.equal(r.json.qaSlots[11].claim, null);
  });

  for (const [what, p, method, body, re] of [
    ['a bad workspace setting', '/api/workspace/settings', 'PUT', { qa: { count: 99 } }, /QA slots is 0 to 40/],
    ['a claim on a slot that is not there', '/api/workspace/slots/qa/99', 'PUT', { owner: 'x' }, /No QA slot/],
    ['releasing a free slot', '/api/workspace/slots/dev/dev2', 'DELETE', {}, /no claim/],
  ]) {
    it(`answers 400 for ${what}`, async () => {
      const r = await api(p, { method, body });
      assert.equal(r.status, 400);
      assert.match(r.json.error, re);
    });
  }

  it('has no route for other slot kinds', async () => {
    assert.equal((await api('/api/workspace/slots/prod/1', { method: 'PUT', body: { owner: 'x' } })).status, 404);
  });
});

describe('board and slots in the demo', () => {
  let app; let api; let cleanup;
  before(async () => {
    const demo = await createDemo();
    cleanup = demo.cleanup;
    app = await createBirddog({ ...demo.options, autoRefresh: false, log: quiet });
    api = client(await app.start(0));
  });
  after(async () => { await app.close(); await cleanup(); });

  it('fills every lane, and links tickets to worktrees and slots', async () => {
    const { json: b } = await api('/api/board');
    assert.equal(b.error, null);
    assert.deepEqual(b.lanes.map((l) => l.cards.length), [2, 2, 1, 2]);
    assert.equal(b.links['PAY-226'].dev[0].label, 'Dev 2');
    assert.equal(b.links['PAY-226'].qa[0].label, 'QA 3');
    assert.match(b.start['PAY-235'], /^git -C ~\/code\/acme-payments worktree add -b feature\/PAY-235 /);
    assert.equal(b.start['PAY-214'], undefined, 'tickets with a worktree get no "new worktree" command');
  });

  it('shows 3 dev slots and 12 QA slots, one of them down', async () => {
    const { json: w } = await api('/api/workspace');
    assert.deepEqual(w.devSlots.map((s) => s.state), ['running', 'claimed', 'free']);
    assert.equal(w.qaSlots.length, 12);
    assert.equal(w.qaSlots.filter((s) => s.state === 'down').length, 1);
    assert.equal(w.qaSlots[4].claim.owner, 'Priya');
    assert.equal(w.tickets['PAY-226'].laneLabel, 'In Code Review');
    // the HTML builders take the real payloads
    const html = workspaceHTML(w);
    assert.match(html, /QA 12/);
    assert.match(html, /41 commits behind main/);
    assert.match(boardHTML({ ...(await api('/api/board')).json }), /Ready for Deployment/);
  });
});

describe('work views (HTML)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const board = {
    connected: true, total: 1, refreshedAt: new Date().toISOString(),
    settings: { scope: 'projects', projects: ['X'], jql: '', lanes: [{ id: 'a', label: 'A', statuses: ['A'] }] },
    lanes: [{ id: 'a', label: evil, statuses: [evil], cards: [{ key: 'X-1', summary: evil, url: 'https://x.atlassian.net/browse/X-1', status: evil, lane: 'a', type: evil, priority: 'High', assignee: evil, fixVersions: [evil], sinceAt: new Date().toISOString(), daysInStatus: 5, updatedAt: null }] }],
    links: { 'X-1': { worktrees: [{ path: `/r/${evil}`, branch: evil, dirty: 1 }], dev: [{ label: evil, state: 'running' }], qa: [{ label: evil, how: 'deployed' }] } },
    start: {},
  };

  it('escapes everything from Jira, git and QA servers', () => {
    const html = boardHTML(board, { settingsOpen: true });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    const ws = {
      settings: { repos: [], ticketPattern: 'x', branchPrefix: '', devSlots: [], qa: { count: 1, pattern: '', versionPath: '', label: 'QA {n}' } },
      repos: [{ name: evil, display: evil, base: evil, worktrees: [{ path: `/r/${evil}`, display: evil, branch: evil, main: false, ticket: 'X-1', changed: 0, untracked: 0, ahead: 0, behind: 0, lastSubject: evil, commands: { open: `code ${evil}` } }] }],
      devSlots: [{ id: 'dev1', label: evil, ports: [], state: 'claimed', ticket: 'X-1', worktree: evil, claim: { note: evil } }],
      qaSlots: [{ n: 1, label: evil, state: 'up', branch: evil, build: evil, claim: { owner: evil, note: evil } }],
      tickets: { 'X-1': { laneLabel: evil, summary: evil, url: 'https://x' } }, links: {}, warnings: [evil],
    };
    const w = workspaceHTML(ws, { settingsOpen: true, claim: { kind: 'dev', id: 'dev1' } });
    assert.doesNotMatch(w, /<img/);
  });

  it('marks a ticket that has sat in its status with an icon and words, not color alone', () => {
    assert.match(boardHTML(board), /⏳<\/span> 5 d in status/);
  });

  it('flags worktrees that need a look', () => {
    const now = Date.now();
    const w = { main: false, ticket: 'A-1', changed: 2, untracked: 0, unpushed: 1, behind: 25, conflicts: 1, lastCommitAt: new Date(now - 20 * 86_400_000).toISOString() };
    assert.deepEqual(worktreeHints(w, { lane: 'deploy' }, now), [
      '1 merge conflict', 'Ready for deployment, but has uncommitted changes', 'Ready for deployment, but has unpushed commits',
      '25 commits behind main: rebase or merge soon', 'No commit in 20 days, with uncommitted work',
    ]);
    assert.deepEqual(worktreeHints({ ...w, conflicts: 0, behind: 0, lastCommitAt: null, changed: 0, unpushed: 0 }, null, now), ['Ticket is not on the board (done, or in another status)']);
    assert.deepEqual(worktreeHints({ main: true, changed: 0, behind: 0 }, null, now), []);
  });

  it('uses no inline event handlers (the page CSP forbids them)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'work.js'), 'utf8');
    assert.doesNotMatch(src, /\son[a-z]+="/);
  });

  it('has Board and Worktrees in the menu and the shortcut sheet', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /<nav class="nav" id="work" aria-label="Work">/);
    assert.match(html, /Board <kbd>b<\/kbd>/);
    assert.match(html, /Worktrees &amp; slots <kbd>w<\/kbd>/);
    const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    assert.match(app, /case 'b': return setView\('board'\)/);
    assert.match(app, /case 'w': return setView\('worktrees'\)/);
  });
});
