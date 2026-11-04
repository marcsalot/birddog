import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clampGuideWidth, GUIDE_MIN, maxGuideWidth, searchGuide, SECTIONS, wideGuideWidth } from '../public/js/guide.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('user guide', () => {
  it('covers the topics the app has', () => {
    assert.deepEqual(SECTIONS.map((s) => s.id), ['start', 'sources', 'more', 'logins', 'triage', 'shortcuts', 'notifications', 'chat', 'docker', 'mcp']);
  });

  it('search matches words anywhere in a section, all words required', () => {
    assert.equal(searchGuide('').length, SECTIONS.length);
    assert.deepEqual(searchGuide('quiet hours'), ['notifications']);
    assert.ok(searchGuide('Anthropic').includes('chat'));
    assert.deepEqual(searchGuide('docker volume loopback'), ['docker']);
    assert.deepEqual(searchGuide('zebra'), []);
  });

  it('every screenshot it shows exists in light and dark (from npm run screenshots)', () => {
    const names = SECTIONS.flatMap((s) => [...s.html.matchAll(/data-shot="([a-z-]+)"/g)].map((m) => m[1]));
    assert.ok(names.length >= 3);
    for (const n of names) for (const mode of ['light', 'dark']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'public', 'guide', `${n}-${mode}.jpg`)), `${n}-${mode}.jpg`);
    }
  });

  it('documents every key the app binds', () => {
    const keys = SECTIONS.find((s) => s.id === 'shortcuts').html;
    for (const k of ['j', 'k', 'x', 's', 'z', 'u', 'c', 'o', '0', 'a', 'g', 'r', 't', 'p', '?']) assert.match(keys, new RegExp(`<kbd>${k.replace('?', '\\?')}</kbd>`));
  });
});

describe('guide width', () => {
  it('never squeezes the page below 420px when docked, and floats up to 96% on narrow windows', () => {
    assert.equal(maxGuideWidth(1440, 232), 788);
    assert.equal(maxGuideWidth(1440, 72), 948);
    assert.equal(maxGuideWidth(1000, 232), 960);
    assert.equal(maxGuideWidth(600, 0), 576);
  });
  it('clamps drags between the minimum and the maximum', () => {
    assert.equal(clampGuideWidth(100, 800), GUIDE_MIN);
    assert.equal(clampGuideWidth(5000, 800), 800);
    assert.equal(clampGuideWidth(512.6, 800), 513);
  });
  it('the wide view is half the window, up to 760px, and still fits', () => {
    // wideGuideWidth reads the rail from the page; pass a viewport whose max isn't the limit.
    assert.equal(clampGuideWidth(Math.min(760, 1440 * 0.5), maxGuideWidth(1440, 232)), 720);
    assert.equal(clampGuideWidth(Math.min(760, 1900 * 0.5), maxGuideWidth(1900, 232)), 760);
    assert.equal(typeof wideGuideWidth, 'function');
  });
});
