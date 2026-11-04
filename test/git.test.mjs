import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import * as gitSource from '../src/sources/git.mjs';
import { commit, DAY, git, tmpDir } from './helpers.mjs';

const { parseStatus, parseRefs, parseTrack, remoteToWeb, branchUrl, shellQuote, findRepos, normalizeSettings } = gitSource;

describe('git parsing', () => {
  it('parses porcelain v2 status', () => {
    const out = [
      '# branch.oid 1234abcd',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/app file.js',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.js',
      'old name.js',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? notes.md',
      '! ignored.log',
      '',
    ].join('\0');
    const s = parseStatus(out);
    assert.equal(s.head, 'feat/x');
    assert.equal(s.upstream, 'origin/feat/x');
    assert.equal(s.ahead, 3);
    assert.equal(s.behind, 1);
    assert.deepEqual(s.changed.map((c) => c.path), ['src/app file.js', 'new name.js', 'conflict.txt']);
    assert.equal(s.changed[2].conflict, true);
    assert.deepEqual(s.untracked, ['notes.md']);
  });

  it('handles detached heads and fresh repos', () => {
    const s = parseStatus('# branch.oid (initial)\0# branch.head (detached)\0');
    assert.equal(s.head, null);
    assert.equal(s.oid, null);
  });

  it('parses branch refs and tracking info', () => {
    const out = 'main\0origin/main\0\u00001700000000\0aaa\nfeat\0origin/feat\0[ahead 2, behind 1]\u00001700000100\0bbb\nold\0origin/old\0[gone]\u00001600000000\0ccc\n';
    const refs = parseRefs(out);
    assert.equal(refs.length, 3);
    assert.deepEqual(refs[1], { name: 'feat', upstream: 'origin/feat', ahead: 2, behind: 1, gone: false, date: 1700000100000, sha: 'bbb' });
    assert.equal(refs[2].gone, true);
    assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
  });

  it('turns remotes into web links', () => {
    assert.equal(remoteToWeb('git@github.com:acme/api.git'), 'https://github.com/acme/api');
    assert.equal(remoteToWeb('https://github.com/acme/api.git'), 'https://github.com/acme/api');
    assert.equal(remoteToWeb('https://user:token@gitlab.com/group/sub/proj'), 'https://gitlab.com/group/sub/proj');
    assert.equal(remoteToWeb('ssh://git@bitbucket.org:7999/team/repo.git'), 'https://bitbucket.org/team/repo');
    assert.equal(remoteToWeb('/srv/git/repo.git'), null);
    assert.equal(remoteToWeb('file:///srv/git/repo.git'), null);
    assert.equal(remoteToWeb(''), null);
  });

  it('builds branch links per host', () => {
    assert.equal(branchUrl('https://github.com/a/b', 'feat/x y'), 'https://github.com/a/b/tree/feat/x%20y');
    assert.equal(branchUrl('https://gitlab.com/a/b', 'dev'), 'https://gitlab.com/a/b/-/tree/dev');
    assert.equal(branchUrl('https://git.example.com/a/b', 'dev'), 'https://git.example.com/a/b');
  });

  it('quotes shell arguments safely', () => {
    assert.equal(shellQuote('feat/x-1'), 'feat/x-1');
    assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
    assert.equal(shellQuote('~/My Code/app'), `~/'My Code/app'`);
    assert.equal(shellQuote('$(rm -rf /)'), `'$(rm -rf /)'`);
  });

  it('validates setup settings', () => {
    assert.deepEqual(normalizeSettings({ roots: '/a\n/b, /a' }), { roots: ['/a', '/b'] });
    assert.throws(() => normalizeSettings({ roots: '  ' }), /at least one/);
    assert.throws(() => normalizeSettings({ roots: 5 }), /list of folders/);
  });
});

describe('git source against real temp repos', () => {
  const now = Date.now();
  let root;
  let items;
  let warnings;

  before(async () => {
    root = await tmpDir();
    const remote = path.join(root, 'remotes', 'app.git');
    await fs.mkdir(remote, { recursive: true });
    git(remote, ['init', '-q', '--bare']);
    const code = path.join(root, 'code');
    await fs.mkdir(code);
    git(code, ['clone', '-q', remote, 'app']);
    const app = path.join(code, 'app');

    await fs.writeFile(path.join(app, 'README.md'), 'hello\n');
    git(app, ['add', 'README.md']);
    commit(app, 'Initial commit', now - 60 * DAY);
    git(app, ['push', '-q', '-u', 'origin', 'main']);
    git(app, ['remote', 'set-head', 'origin', 'main']);

    // Merged into main, then main moves on.
    git(app, ['checkout', '-q', '-b', 'done-work']);
    commit(app, 'Finished feature', now - 20 * DAY);
    git(app, ['checkout', '-q', 'main']);
    git(app, ['merge', '-q', '--ff-only', 'done-work']);
    commit(app, 'Later work on main', now - 15 * DAY);
    git(app, ['push', '-q']);

    // Old, unmerged, never pushed: stale, not "unpushed".
    git(app, ['checkout', '-q', '-b', 'old-spike', 'main~1']);
    commit(app, 'Spike', now - 90 * DAY);

    // Never pushed, 4 days old: Now.
    git(app, ['checkout', '-q', '-b', 'feat/rate-limit', 'main']);
    commit(app, 'Token bucket', now - 5 * DAY);
    commit(app, 'Wire limiter', now - 4 * DAY);

    // Pushed, then one fresh commit: Later.
    git(app, ['checkout', '-q', '-b', 'pushed-ahead', 'main']);
    commit(app, 'First', now - 2 * DAY);
    git(app, ['push', '-q', '-u', 'origin', 'pushed-ahead']);
    commit(app, 'Fresh', now - 60_000);

    // Uncommitted edit that has been sitting for 5 days.
    git(app, ['checkout', '-q', 'main']);
    await fs.writeFile(path.join(app, 'README.md'), 'hello world\n');
    const old = new Date(now - 5 * DAY);
    await fs.utimes(path.join(app, 'README.md'), old, old);

    // A local-only repo (no remote): unpushed commits are not reported.
    const solo = path.join(code, 'nested', 'solo');
    await fs.mkdir(solo, { recursive: true });
    git(solo, ['init', '-q']);
    commit(solo, 'Local only', now - 10 * DAY);

    // Skipped folders are not scanned.
    await fs.mkdir(path.join(code, 'node_modules', 'pkg', '.git'), { recursive: true });

    warnings = [];
    items = await gitSource.collect({ roots: [code, path.join(root, 'missing')], staleDays: 30 }, { now, warn: (w) => warnings.push(w) });
  });

  const find = (kind, pred = () => true) => items.find((i) => i.kind === kind && pred(i));

  it('finds repos but skips node_modules', async () => {
    const repos = await findRepos(path.join(root, 'code'));
    assert.deepEqual(repos.map((r) => path.relative(root, r)), ['code/app', 'code/nested/solo']);
  });

  it('warns about missing folders but keeps going', () => {
    assert.ok(warnings.some((w) => w.includes('missing') && w.includes('does not exist')));
  });

  it('reports old unpushed work as Now', () => {
    const it = find('unpushed', (i) => i.meta.fields.Branch === 'feat/rate-limit');
    assert.ok(it, 'expected an unpushed item for feat/rate-limit');
    assert.equal(it.urgency, 'now');
    assert.equal(it.title, 'app · 2 unpushed commits on feat/rate-limit');
    assert.match(it.meta.command, /push -u origin feat\/rate-limit$/);
    assert.equal(it.meta.fields['Latest commit'], 'Wire limiter');
  });

  it('reports fresh commits ahead of upstream as Later', () => {
    const it = find('unpushed', (i) => i.meta.fields.Branch === 'pushed-ahead');
    assert.equal(it.urgency, 'later');
    assert.equal(it.meta.fields['Unpushed commits'], 1);
    assert.match(it.why, /Ahead of the remote/);
  });

  it('reports uncommitted edits with their age', () => {
    const it = find('uncommitted', (i) => i.title.startsWith('app'));
    assert.equal(it.urgency, 'today');
    assert.match(it.why, /5 days/);
    assert.match(it.meta.fields.Files, /README\.md/);
  });

  it('lists merged branches as safe to delete', () => {
    const it = find('merged-branches');
    assert.equal(it.meta.fields.Branches, 'done-work');
    assert.match(it.meta.command, /branch -d done-work$/);
    assert.match(it.why, /merged into \*\*main\*\*/);
  });

  it('lists stale branches without also calling them unpushed', () => {
    const it = find('stale-branches');
    assert.match(it.meta.fields.Branches, /^old-spike \(3 months\)$/);
    assert.equal(find('unpushed', (i) => i.meta.fields.Branch === 'old-spike'), undefined);
  });

  it('ignores repos with no remote for unpushed checks', () => {
    assert.equal(items.some((i) => i.meta.path?.endsWith('solo') && i.kind === 'unpushed'), false);
  });

  it('gives every item a stable id and a rule', async () => {
    const again = await gitSource.collect({ roots: [path.join(root, 'code')] }, { now });
    assert.deepEqual(again.map((i) => i.id).sort(), items.map((i) => i.id).sort());
    for (const i of items) assert.ok(i.meta.rule?.text, `${i.id} has no rule`);
  });

  it('test() summarizes what it found', async () => {
    const r = await gitSource.test({ roots: [path.join(root, 'code')] });
    assert.equal(r.ok, true);
    assert.match(r.message, /Found 2 repos/);
    const bad = await gitSource.test({ roots: [path.join(root, 'nope')] });
    assert.equal(bad.ok, false);
  });

  it('collect() fails loudly when no folder exists', async () => {
    await assert.rejects(gitSource.collect({ roots: [path.join(root, 'nope')] }), /None of the scan folders exist/);
  });
});
