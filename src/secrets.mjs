// Where Birddog keeps tokens and session keys.
//
//   macOS   → Keychain (via the `security` tool; the value goes over stdin, never argv)
//   Linux   → Secret Service (via `secret-tool`, e.g. GNOME Keyring), if installed
//   else    → secrets.json in the config dir, readable only by you (mode 600)
//
// Force a backend with BIRDDOG_SECRETS=keychain|secret-service|file.

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

const SERVICE = 'birddog';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(err.trim() || `${cmd} exited with ${code}`), { exitCode: code }));
    });
    child.stdin.end(input ?? '');
  });
}

const keychain = {
  kind: 'macOS Keychain',
  async get(name) {
    try { return (await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'])).replace(/\n$/, ''); } catch (e) {
      if (e.exitCode === 44) return null; // not found
      throw e;
    }
  },
  async set(name, value) {
    // `security -i` reads commands from stdin, so the secret never shows up in `ps`.
    if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) {
      throw new Error('This secret has characters the macOS Keychain helper cannot store safely');
    }
    await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${name} -w "${value}"\n`);
  },
  async delete(name) {
    try { await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]); } catch (e) {
      if (e.exitCode !== 44) throw e;
    }
  },
};

const secretService = {
  kind: 'Secret Service',
  async get(name) {
    try { return (await run('secret-tool', ['lookup', 'service', SERVICE, 'account', name])) || null; } catch (e) {
      if (e.exitCode === 1) return null;
      throw e;
    }
  },
  async set(name, value) {
    await run('secret-tool', ['store', `--label=Birddog ${name}`, 'service', SERVICE, 'account', name], value);
  },
  async delete(name) {
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', name]).catch(() => {});
  },
};

function fileStore(dir) {
  const file = path.join(dir, 'secrets.json');
  return {
    kind: 'file (secrets.json, mode 600)',
    async get(name) { return (await readJson(file, {}))[name] ?? null; },
    async set(name, value) { const all = await readJson(file, {}); all[name] = value; await writeJson(file, all); },
    async delete(name) { const all = await readJson(file, {}); delete all[name]; await writeJson(file, all); },
  };
}

const has = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 3000 }, (e) => r(!e || e.code !== 'ENOENT')));

async function pickBackend(dir, wanted) {
  if (wanted === 'file') return fileStore(dir);
  if (wanted === 'keychain') return keychain;
  if (wanted === 'secret-service') return secretService;
  if (process.platform === 'darwin' && await has('security', ['help'])) return keychain;
  if (process.platform === 'linux' && await has('secret-tool', ['--version'])) return secretService;
  return fileStore(dir);
}

/** A small get/set/delete store for secrets, keyed by short names like "github-token". */
export async function createSecretStore({ dir, backend = process.env.BIRDDOG_SECRETS } = {}) {
  const impl = await pickBackend(dir, backend);
  const check = (name) => { if (!NAME.test(name)) throw new Error(`bad secret name "${name}"`); };
  return {
    kind: impl.kind,
    async get(name) { check(name); return impl.get(name); },
    async set(name, value) {
      check(name);
      if (typeof value !== 'string' || !value) throw new Error('secret must be a non-empty string');
      return impl.set(name, value);
    },
    async delete(name) { check(name); return impl.delete(name); },
  };
}
