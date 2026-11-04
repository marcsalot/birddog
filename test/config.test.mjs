import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { configDir, expandHome, loadConfig, tildify } from '../src/config.mjs';
import { tmpDir } from './helpers.mjs';

describe('config', () => {
  it('honours BIRDDOG_HOME, then XDG_CONFIG_HOME', () => {
    assert.equal(configDir({ BIRDDOG_HOME: '/tmp/bd' }), path.resolve('/tmp/bd'));
    assert.equal(configDir({ XDG_CONFIG_HOME: '/tmp/xdg' }), path.join('/tmp/xdg', 'birddog'));
    assert.equal(configDir({}), path.join(os.homedir(), '.config', 'birddog'));
  });

  it('expands and shortens ~', () => {
    assert.equal(expandHome('~/code'), path.join(os.homedir(), 'code'));
    assert.equal(tildify(path.join(os.homedir(), 'code')), '~/code');
    assert.equal(tildify('/opt/x'), '/opt/x');
  });

  it('creates a config on first run and merges defaults later', async () => {
    const dir = await tmpDir();
    const first = await loadConfig(dir, { cwd: dir });
    assert.equal(first.created, true);
    assert.ok(first.config.sources.git.roots.length >= 1);

    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ sources: { git: { roots: ['/x'] } } }));
    const second = await loadConfig(dir);
    assert.equal(second.created, false);
    assert.deepEqual(second.config.sources.git.roots, ['/x']);
    assert.equal(second.config.sources.git.staleDays, 30, 'defaults fill in missing keys');
    assert.equal(second.config.port, 4747);
  });

  it('moves a broken config aside instead of crashing', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'config.json'), '{ nope');
    const warn = console.warn;
    console.warn = () => {};
    try {
      const { created } = await loadConfig(dir, { cwd: dir });
      assert.equal(created, true);
    } finally { console.warn = warn; }
    assert.ok((await fs.readdir(dir)).some((f) => f.startsWith('config.json.broken-')));
  });
});
