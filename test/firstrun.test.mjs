// The one-step first run: which repo folders to offer, and which to tick.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { repoFolders } from '../src/firstrun.mjs';
import { tmpDir } from './helpers.mjs';

async function repo(dir) { await fs.mkdir(path.join(dir, '.git'), { recursive: true }); }

describe('first-run repo folders', () => {
  it('ticks the configured folder and counts its repos', async () => {
    const root = await tmpDir();
    await repo(path.join(root, 'a')); await repo(path.join(root, 'b')); await repo(path.join(root, 'nested', 'c'));
    const r = await repoFolders({ roots: [root], cwd: root, container: true });
    const f = r.folders.find((x) => x.path.endsWith(path.basename(root)));
    assert.deepEqual([f.selected, f.repos], [true, 3]);
    assert.equal(r.folders.filter((x) => x.path === f.path).length, 1, 'cwd == root is listed once');
  });

  it('when the configured folder has no repos, ticks the folders that do', async () => {
    const empty = await tmpDir();
    const full = await tmpDir();
    await repo(path.join(full, 'x'));
    const r = await repoFolders({ roots: [empty], candidates: [full, '/definitely/not/here'], cwd: '' });
    const pick = Object.fromEntries(r.folders.map((x) => [x.repos, x.selected]));
    assert.deepEqual(pick, { 0: false, 1: true });
    assert.equal(r.folders.length, 2, 'missing folders are not offered');
  });

  it('in Docker offers the configured folders and /repos only', async () => {
    const root = await tmpDir();
    const r = await repoFolders({ roots: [root], container: true, candidates: ['/should/not/be/used'] });
    assert.equal(r.home, '/repos');
    assert.ok(r.folders.length <= 2);
  });
});
