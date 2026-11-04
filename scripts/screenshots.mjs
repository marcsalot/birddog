#!/usr/bin/env node
// Screenshots for the user guide (public/guide/*.jpg), in light and dark.
//
//   npm run screenshots
//
// Always runs Birddog in --demo mode on its own port, so screenshots only ever show
// made-up data: never your repos, tokens or meetings. Playwright is a devDependency;
// Birddog itself still has no runtime dependencies.
//
// Needs a Chromium for Playwright: `npx playwright install chromium` (or set
// BIRDDOG_CHROMIUM to a Chrome/Chromium executable).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'guide');
const VIEWPORT = { width: 1280, height: 800 };

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  console.error('Playwright is not installed. Run `npm install` in the repo first (it is a devDependency).');
  process.exit(1);
}

/** Playwright's own browser if installed; otherwise BIRDDOG_CHROMIUM, or a cached build. */
function executablePath() {
  if (process.env.BIRDDOG_CHROMIUM) return process.env.BIRDDOG_CHROMIUM;
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch { /* not installed */ }
  const cache = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const shells = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of shells) {
    for (const sub of fs.readdirSync(path.join(cache, d))) {
      const exe = path.join(cache, d, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
      if (fs.existsSync(exe)) { console.log(`  using cached ${d}`); return exe; }
    }
  }
  console.error('No Chromium for Playwright. Run `npx playwright install chromium`, or set BIRDDOG_CHROMIUM.');
  process.exit(1);
}

function startDemo() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/birddog.mjs'), '--demo', '--port', '4891'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /pointing at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) resolve({ child, url: m[1] });
    });
    child.on('exit', (code) => reject(new Error(`birddog --demo exited (${code})`)));
    setTimeout(() => reject(new Error('birddog --demo did not start')), 20_000);
  });
}

const { child, url } = await startDemo();
const browser = await chromium.launch({ executablePath: executablePath() });
fs.mkdirSync(OUT, { recursive: true });
const shots = [];

try {
  for (const mode of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: mode, reducedMotion: 'reduce' });
    const save = async (name) => {
      await page.evaluate(() => document.querySelector('#toast')?.classList.remove('show'));
      const file = path.join(OUT, `${name}-${mode}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 80 });
      shots.push(path.relative(ROOT, file));
    };
    await page.goto(url);
    await page.waitForSelector('.ov-grid');
    await page.evaluate(() => document.querySelector('.viz-tip')?.setAttribute('hidden', ''));
    await save('overview');

    await page.keyboard.press('1');
    await page.waitForSelector('.row');
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#drawer.open');
    await page.waitForTimeout(300);
    await save('inbox');

    await page.keyboard.press('Escape');
    await page.keyboard.press('a');
    await page.waitForSelector('#chatPanel.open #chatForm, #chatPanel.open [data-chat="enable"]');
    if (await page.$('#chatConsent')) {
      await page.check('#chatConsent');
      await page.click('[data-chat="enable"]');
      await page.waitForSelector('#chatForm');
    }
    await page.click('[data-chat="new"]');
    await page.click('[data-chat-ask="What needs me now?"]');
    await page.waitForFunction(() => /start with/.test(document.querySelector('#chatPanel .msg-bot')?.textContent ?? ''), null, { timeout: 15_000 });
    await page.waitForTimeout(200);
    await save('chat');

    // The first-run screen, as a brand-new install shows it (demo folders, never your disk).
    await page.evaluate(() => fetch('/api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seenSetup: false }) }));
    await page.reload();
    await page.waitForSelector('#setupScrim.open [data-fr-go]:not([disabled])');
    await page.waitForTimeout(400);
    await save('first-run');
    await page.click('[data-fr-go]');
    await page.waitForSelector('.row');
    await page.close();
  }
  console.log(`\n  Saved ${shots.length} screenshots (demo data only):\n${shots.map((s) => `    ${s}`).join('\n')}\n`);
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
