// Where Birddog keeps tokens and session keys.
//
//   macOS   → Keychain (via the `security` tool; the value goes over stdin, never argv)
//   Linux   → Secret Service (via `secret-tool`, e.g. GNOME Keyring), if installed
//   else    → secrets.json in the config dir, readable only by you (mode 600)
//
// Only the keychain and Secret Service encrypt at rest. When Birddog falls back to
// the file, `store.secure` is false and `store.warning` says so; setup and the
// startup banner show that warning.
//
// Force a backend with BIRDDOG_SECRETS=keychain|secret-service|file|env.
//
//   env     → read-only: secrets come from environment variables or files (Docker
//             secrets), e.g. GITHUB_TOKEN or BIRDDOG_JIRA_TOKEN_FILE=/run/secrets/jira.
//             Nothing is ever written. The Docker image uses this.
//
// In container mode (BIRDDOG_CONTAINER=1, set by the Docker image) only `env` is
// allowed: a container has no keychain, and Birddog refuses to fall back to a
// plain-text secrets.json on the config volume.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
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

// `security find-generic-password -w` prints values that are not plain ASCII as hex,
// which can't be told apart from a hex token. So those are stored as "b64:<base64>".
const B64 = 'b64:';
export const toKeychain = (v) => (/^[\x20-\x7e]*$/.test(v) && !v.startsWith(B64) ? v : B64 + Buffer.from(v, 'utf8').toString('base64'));
export const fromKeychain = (v) => (v.startsWith(B64) ? Buffer.from(v.slice(B64.length), 'base64').toString('utf8') : v);

const keychain = {
  kind: 'macOS Keychain',
  secure: true,
  async get(name) {
    try { return fromKeychain((await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'])).replace(/\n$/, '')); } catch (e) {
      if (e.exitCode === 44) return null; // not found
      throw e;
    }
  },
  async set(name, value) {
    // `security -i` reads commands from stdin, so the secret never shows up in `ps`.
    // -X takes the value hex-encoded, so no character in it can break the command line.
    const hex = Buffer.from(toKeychain(value), 'utf8').toString('hex');
    await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${name} -X ${hex}\n`);
  },
  async delete(name) {
    try { await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]); } catch (e) {
      if (e.exitCode !== 44) throw e;
    }
  },
};

const secretService = {
  kind: 'Secret Service',
  secure: true,
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
    secure: false,
    async get(name) { return (await readJson(file, {}))[name] ?? null; },
    async set(name, value) { const all = await readJson(file, {}); all[name] = value; await writeJson(file, all); },
    async delete(name) { const all = await readJson(file, {}); delete all[name]; await writeJson(file, all); },
  };
}

/** Which environment variable holds each secret. Each also has a NAME_FILE variant. */
export const ENV_SECRETS = Object.freeze({
  'github-token': ['GITHUB_TOKEN', 'GH_TOKEN'],
  'jira-token': ['BIRDDOG_JIRA_TOKEN'],
  'cal-url': ['BIRDDOG_CAL_URL'],
  'oidc-client-secret': ['BIRDDOG_OIDC_CLIENT_SECRET'],
  'session-key': ['BIRDDOG_SESSION_KEY'],
  'anthropic-api-key': ['ANTHROPIC_API_KEY', 'BIRDDOG_ANTHROPIC_API_KEY'],
  'caldav-password': ['BIRDDOG_CALDAV_PASSWORD'],
  'google-client-secret': ['BIRDDOG_GOOGLE_CLIENT_SECRET'],
  'atlassian-client-secret': ['BIRDDOG_ATLASSIAN_CLIENT_SECRET'],
  'apple-private-key': ['BIRDDOG_APPLE_PRIVATE_KEY'],
});

export class ReadOnlySecretsError extends Error {}

function envStore(env) {
  const lookup = (name) => {
    for (const v of ENV_SECRETS[name] ?? []) {
      if (env[v]?.trim()) return { value: env[v].trim(), from: v };
      const file = env[`${v}_FILE`];
      if (file) {
        try {
          const value = fs.readFileSync(file, 'utf8').trim();
          if (value) return { value, from: `${v}_FILE` };
        } catch (err) {
          throw new Error(`${v}_FILE points at ${file}, which Birddog cannot read (${err.code ?? err.message})`);
        }
      }
    }
    return null;
  };
  const refuse = (name, verb) => {
    const vars = ENV_SECRETS[name];
    throw new ReadOnlySecretsError(vars
      ? `Birddog reads secrets from the environment here and never stores them. To ${verb} it, ${verb === 'remove' ? 'unset' : 'set'} ${vars[0]} (or ${vars[0]}_FILE for a Docker secret) and restart.`
      : `Birddog reads secrets from the environment here and cannot ${verb} "${name}".`);
  };
  return {
    kind: 'environment variables',
    secure: true,
    readOnly: true,
    async get(name) { return lookup(name)?.value ?? null; },
    /** Where a secret comes from ("BIRDDOG_JIRA_TOKEN_FILE"), and which variable to set. For setup screens; never the value. */
    describe(name) {
      const vars = ENV_SECRETS[name] ?? [];
      let found = null;
      try { found = lookup(name)?.from ?? null; } catch { found = null; }
      return { variable: vars[0] ?? null, from: found };
    },
    async set(name) { refuse(name, 'save'); },
    async delete(name) { refuse(name, 'remove'); },
  };
}

const has = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 3000 }, (e) => r(!e || e.code !== 'ENOENT')));

async function pickBackend(dir, wanted, env) {
  if (env.BIRDDOG_CONTAINER === '1' && wanted && wanted !== 'env') {
    throw new Error(`BIRDDOG_SECRETS=${wanted} is not allowed in a container: there is no keychain, and Birddog will not keep secrets in plain text on the config volume. Leave BIRDDOG_SECRETS unset (or "env") and pass tokens as environment variables or Docker secrets.`);
  }
  if (wanted === 'env' || env.BIRDDOG_CONTAINER === '1') return envStore(env);
  if (wanted === 'file') return fileStore(dir);
  if (wanted === 'keychain') return keychain;
  if (wanted === 'secret-service') return secretService;
  if (process.platform === 'darwin' && await has('security', ['help'])) return keychain;
  if (process.platform === 'linux' && await has('secret-tool', ['--version'])) return secretService;
  return fileStore(dir);
}

/** A small get/set/delete store for secrets, keyed by short names like "github-token". */
export async function createSecretStore({ dir, backend = process.env.BIRDDOG_SECRETS, env = process.env } = {}) {
  const impl = await pickBackend(dir, backend, env);
  const check = (name) => { if (!NAME.test(name)) throw new Error(`bad secret name "${name}"`); };
  const why = backend === 'file' ? 'the file store was chosen (BIRDDOG_SECRETS=file)'
    : process.platform === 'linux' ? 'no Secret Service found (install libsecret-tools and a keyring such as GNOME Keyring)'
      : `no OS keychain support on ${process.platform}`;
  return {
    kind: impl.kind,
    secure: impl.secure,
    readOnly: !!impl.readOnly,
    describe: impl.describe ? (name) => { check(name); return impl.describe(name); } : null,
    warning: impl.secure ? null
      : `Secrets are in ${path.join(dir, 'secrets.json')} (readable only by you, but not encrypted) because ${why}.`,
    async get(name) { check(name); return impl.get(name); },
    async set(name, value) {
      check(name);
      if (typeof value !== 'string' || !value) throw new Error('secret must be a non-empty string');
      return impl.set(name, value);
    },
    async delete(name) { check(name); return impl.delete(name); },
  };
}
