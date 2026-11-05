import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boardFromIssues, boardJql, boardSettings, cardOf, createBoard, DEFAULT_LANES, laneOf, normalizeBoard, statusSince,
} from '../src/board.mjs';
import { DAY, fakeFetch } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 5, 12);
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const SITE = 'https://acme.atlassian.net';

const issue = (key, status, { movedDaysAgo, ...fields } = {}) => ({
  key,
  changelog: movedDaysAgo === undefined ? undefined : { histories: [{ created: iso(movedDaysAgo), items: [{ field: 'status', toString: status }] }] },
  fields: { summary: `Summary ${key}`, status: { name: status }, priority: { name: 'High' }, issuetype: { name: 'Bug' }, assignee: { displayName: 'Ana' }, fixVersions: [{ name: '1.2' }], updated: iso(0.1), ...fields },
});

describe('board settings', () => {
  it('defaults to the four delivery lanes, assigned to me', () => {
    const s = normalizeBoard({});
    assert.equal(s.scope, 'mine');
    assert.deepEqual(s.lanes.map((l) => l.label), ['In Progress', 'In Code Review', 'Code Review Pass', 'Ready for Deployment']);
    assert.deepEqual(s.lanes.map((l) => l.id), ['progress', 'review', 'passed', 'deploy']);
  });

  it('cleans lanes: trims, splits comma lists, dedupes statuses and makes ids from names', () => {
    const s = normalizeBoard({ lanes: [{ label: '  QA  ready ', statuses: 'Ready for QA, In QA ,In QA' }, { label: 'Done-ish', statuses: ['Closed'] }] });
    assert.deepEqual(s.lanes, [
      { id: 'qa-ready', label: 'QA ready', statuses: ['Ready for QA', 'In QA'] },
      { id: 'done-ish', label: 'Done-ish', statuses: ['Closed'] },
    ]);
  });

  it('keeps ids unique', () => {
    const s = normalizeBoard({ lanes: [{ label: 'A', statuses: ['x'] }, { label: 'A', statuses: ['y'] }] });
    assert.notEqual(s.lanes[0].id, s.lanes[1].id);
  });

  it('refuses a status in two lanes, whatever the case or spacing', () => {
    assert.throws(() => normalizeBoard({ lanes: [{ label: 'A', statuses: ['In  Review'] }, { label: 'B', statuses: ['in review'] }] }), /in both "A" and "B"/);
  });

  for (const [what, input, re] of [
    ['no lanes', { lanes: [] }], ['too many lanes', { lanes: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, statuses: [`s${i}`] })) }],
    ['a nameless lane', { lanes: [{ label: ' ', statuses: ['x'] }] }], ['a lane without statuses', { lanes: [{ label: 'A', statuses: [] }] }],
    ['a quote in a status (JQL injection)', { lanes: [{ label: 'A', statuses: ['x") OR project = SECRET OR status in ("y'] }] }],
    ['an unknown scope', { scope: 'everyone' }], ['projects scope without projects', { scope: 'projects' }],
    ['a bad project key', { scope: 'projects', projects: ['PROJ; DROP'] }], ['jql scope without a filter', { scope: 'jql', jql: ' ' }],
    ['ORDER BY in the filter', { scope: 'jql', jql: 'project = A ORDER BY rank' }],
  ].map(([w, i]) => [w, i])) {
    it(`refuses ${what}`, () => assert.throws(() => normalizeBoard(input), TypeError, re));
  }

  it('accepts project keys as a string', () => {
    assert.deepEqual(normalizeBoard({ scope: 'projects', projects: 'proj, dba' }).projects, ['PROJ', 'DBA']);
  });

  it('falls back to defaults when config.json holds something broken', () => {
    assert.equal(boardSettings({ board: { scope: 'nope' } }).lanes.length, DEFAULT_LANES.length);
  });
});

describe('board JQL', () => {
  it('asks for my tickets in any lane status, newest first', () => {
    const jql = boardJql(normalizeBoard({ lanes: [{ label: 'A', statuses: ['In Progress', 'Code Review'] }] }));
    assert.equal(jql, 'assignee = currentUser() AND status in ("In Progress", "Code Review") ORDER BY updated DESC');
  });
  it('scopes to projects, or wraps your own filter in brackets', () => {
    assert.match(boardJql(normalizeBoard({ scope: 'projects', projects: ['PROJ', 'DBA'] })), /^project in \("PROJ", "DBA"\) AND status in/);
    assert.match(boardJql(normalizeBoard({ scope: 'jql', jql: 'sprint in openSprints() OR labels = x' })), /^\(sprint in openSprints\(\) OR labels = x\) AND status in/);
  });
});

describe('lanes and cards', () => {
  const lanes = DEFAULT_LANES;
  it('matches statuses whatever the case and spacing', () => {
    assert.equal(laneOf('in code review', lanes), 'review');
    assert.equal(laneOf('In  Code Review Pass', lanes), 'passed');
    assert.equal(laneOf('Ready For Deployment', lanes), 'deploy');
    assert.equal(laneOf('Done', lanes), null);
  });

  it('time in status comes from the newest change into the current status', () => {
    const i = issue('A-1', 'In Code Review');
    i.changelog = { histories: [
      { created: iso(9), items: [{ field: 'status', toString: 'In Code Review' }] },
      { created: iso(6), items: [{ field: 'status', toString: 'In Progress' }] },
      { created: iso(2), items: [{ field: 'assignee', toString: 'In Code Review' }, { field: 'status', toString: 'in code review' }] },
      { created: 'garbage', items: [{ field: 'status', toString: 'In Code Review' }] },
    ] };
    assert.equal(statusSince(i), NOW - 2 * DAY);
  });

  it('falls back to the status-category date, then to nothing', () => {
    assert.equal(statusSince(issue('A-1', 'X', { statuscategorychangedate: iso(3) })), NOW - 3 * DAY);
    assert.equal(statusSince(issue('A-1', 'X')), null);
  });

  it('builds a card with the facts the board shows', () => {
    const c = cardOf(issue('PROJ-7', 'Code Review', { movedDaysAgo: 1.5 }), { site: SITE, lanes, now: NOW });
    assert.deepEqual(c, {
      key: 'PROJ-7', summary: 'Summary PROJ-7', url: `${SITE}/browse/PROJ-7`, status: 'Code Review', lane: 'review', type: 'Bug', priority: 'High',
      assignee: 'Ana', fixVersions: ['1.2'], sinceAt: iso(1.5), daysInStatus: 1.5, updatedAt: iso(0.1),
    });
  });

  it('sorts lanes in order, longest-sitting first, and drops tickets in no lane', () => {
    const b = boardFromIssues([
      issue('A-1', 'In Progress', { movedDaysAgo: 1 }), issue('A-2', 'In Progress', { movedDaysAgo: 4 }), issue('A-3', 'Done', { movedDaysAgo: 1 }),
      issue('A-4', 'Ready for Deployment'), issue('A-10', 'Ready for Deployment'), issue('A-9', 'Ready for Deployment'),
    ], { site: SITE, lanes, now: NOW });
    assert.deepEqual(b.map((l) => [l.id, l.cards.map((c) => c.key)]), [
      ['progress', ['A-2', 'A-1']], ['review', []], ['passed', []], ['deploy', ['A-4', 'A-9', 'A-10']],
    ]);
  });
});

describe('board service', () => {
  const config = (over = {}) => ({ sources: { jira: { enabled: true, site: SITE, email: 'me@acme.example' } }, ...over });
  const ctx = (fetchImpl) => ({ fetch: fetchImpl, secret: async (n) => (n === 'jira-token' ? 'tok' : null) });

  it('says Jira is not connected without calling anything', async () => {
    const f = fakeFetch(() => { throw new Error('no calls'); });
    const b = await createBoard({ getConfig: () => ({ sources: {} }), context: ctx(f), now: () => NOW }).get();
    assert.equal(b.connected, false);
    assert.equal(b.lanes.length, 4);
    assert.equal(f.calls.length, 0);
  });

  it('runs one read-only search with the changelog, and caches it for a minute', async () => {
    let t = NOW;
    const f = fakeFetch((u) => {
      if (u.pathname === '/rest/api/3/search/jql') return { body: { isLast: true, issues: [issue('A-1', 'In Code Review Pass', { movedDaysAgo: 0.5 }), issue('A-2', 'Done')] } };
      return undefined;
    });
    const board = createBoard({ getConfig: () => config(), context: ctx(f), now: () => t });
    const b = await board.get();
    assert.equal(b.connected, true);
    assert.equal(b.error, null);
    assert.equal(b.total, 1);
    assert.equal(b.lanes.find((l) => l.id === 'passed').cards[0].key, 'A-1');
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.url.searchParams.get('expand'), 'changelog');
    assert.match(call.url.searchParams.get('jql'), /^assignee = currentUser\(\) AND status in \("In Progress"/);
    assert.match(call.headers.authorization, /^Basic /);

    await board.get();
    assert.equal(f.calls.length, 1, 'cached');
    t += 61_000;
    await board.get();
    assert.equal(f.calls.length, 2, 'expired');
    await board.get({ fresh: true });
    assert.equal(f.calls.length, 3, 'fresh skips the cache');
  });

  it('pages through results, three pages at most', async () => {
    let n = 0;
    const f = fakeFetch(() => ({ body: { issues: [issue(`A-${++n}`, 'In Progress')], nextPageToken: `p${n}`, isLast: false } }));
    const b = await createBoard({ getConfig: () => config(), context: ctx(f), now: () => NOW }).get();
    assert.equal(f.calls.length, 3);
    assert.equal(b.total, 3);
    assert.equal(b.truncated, true);
    assert.equal(f.calls[1].url.searchParams.get('nextPageToken'), 'p1');
  });

  it('turns Jira errors into a message instead of throwing', async () => {
    const f = fakeFetch(() => ({ status: 401, body: {} }));
    const b = await createBoard({ getConfig: () => config(), context: ctx(f), now: () => NOW }).get();
    assert.match(b.error, /rejected the email or API token/);
    assert.equal(b.total, 0);
  });

  it('reloads when the board settings change', async () => {
    let cfg = config();
    const f = fakeFetch(() => ({ body: { isLast: true, issues: [] } }));
    const board = createBoard({ getConfig: () => cfg, context: ctx(f), now: () => NOW });
    await board.get();
    cfg = config({ board: { scope: 'projects', projects: ['PROJ'] } });
    const b = await board.get();
    assert.equal(f.calls.length, 2);
    assert.match(b.jql, /^project in \("PROJ"\)/);
  });
});
