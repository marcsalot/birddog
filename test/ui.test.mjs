// Static checks on the page structure the UI depends on (no browser needed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Triage } from '../src/triage.mjs';
import { tmpDir } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

describe('main menu rail', () => {
  it('is a labelled landmark with a toggle, a phone menu button and the tools', () => {
    assert.match(html, /<aside class="rail" id="rail" aria-label="Main menu">/);
    assert.match(html, /id="railToggle" aria-controls="rail" aria-expanded="true"/);
    assert.match(html, /id="menuBtn" aria-label="Menu \(m\)" aria-controls="rail"/);
    for (const id of ['chatBtn', 'guideTab', 'helpBtn', 'openSetup']) assert.match(html, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`), `${id} keeps a name when collapsed`);
    assert.match(html, /<aside class="guide" id="guideRail"/, 'the guide rail lives in the same layout');
  });

  it('remembers its state (and the guide\'s) in prefs', async () => {
    const t = new Triage({ dir: await tmpDir() });
    await t.load();
    assert.equal(t.prefs.railOpen, true);
    assert.equal(t.prefs.guideOpen, false);
    assert.deepEqual(await t.setPrefs({ railOpen: false, guideOpen: true }), []);
    assert.deepEqual(await t.setPrefs({ railOpen: 'yes' }), ['railOpen']);
    const again = new Triage({ dir: t.file.replace(/\/state\.json$/, '') });
    await again.load();
    assert.deepEqual([again.prefs.railOpen, again.prefs.guideOpen], [false, true]);
  });

  it('remembers how wide the guide is', async () => {
    const t = new Triage({ dir: await tmpDir() });
    await t.load();
    assert.equal(t.prefs.guideWidth, null, 'default width until you drag it');
    assert.deepEqual(await t.setPrefs({ guideWidth: 640 }), []);
    for (const bad of ['wide', 12, 99999, 400.5]) assert.deepEqual(await t.setPrefs({ guideWidth: bad }), ['guideWidth'], String(bad));
    const again = new Triage({ dir: t.file.replace(/\/state\.json$/, '') });
    await again.load();
    assert.equal(again.prefs.guideWidth, 640);
    assert.deepEqual(await again.setPrefs({ guideWidth: null }), [], 'reset to the default');
  });
});

describe('Ask Fetch setup form', () => {
  it('reads the pasted API key before re-rendering the form (which empties the field)', () => {
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');
    const block = js.slice(js.indexOf("d.chat === 'enable'"));
    const read = block.indexOf("$('#chatKey')");
    const rerender = block.indexOf('busy = true; render()');
    assert.ok(read > 0 && rerender > 0, 'enable handler found');
    assert.ok(read < rerender, 'the key is read before render() rebuilds the input');
  });
});
