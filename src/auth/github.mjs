// "Sign in with GitHub" for the GitHub source.
//
// Two ways in, no pasted tokens:
//   • Device flow: Birddog shows a short code, you approve it on github.com.
//     Needs an OAuth App client ID (sources.github.clientId) with device flow enabled.
//     The token is stored in your OS keychain.
//   • gh CLI: if you already ran `gh auth login`, Birddog asks `gh` for a token
//     each time it needs one and stores nothing itself.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { readJson, writeJson } from '../store.mjs';

export const GITHUB_DEFAULTS = Object.freeze({ webUrl: 'https://github.com', apiUrl: 'https://api.github.com', scopes: 'repo read:org' });
const SECRET = 'github-token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export function ghCliToken(host) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') return reject(new Error('The GitHub CLI (gh) is not installed. Install it, or use "Sign in with GitHub".'));
      if (err) return reject(new Error(`gh is not signed in to ${host}. Run "gh auth login" first. (${String(stderr).trim().split('\n')[0]})`));
      resolve(stdout.trim());
    });
  });
}

export function createGithubAuth({ dir, secrets, getConfig, fetchImpl = fetch, cliToken = ghCliToken, now = () => Date.now(), sleep, onChange = () => {} }) {
  const file = path.join(dir, 'connections.json');
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  let device = null; // the device flow in progress, if any
  const notify = () => { Promise.resolve().then(onChange).catch(() => {}); };

  const settings = () => ({ ...GITHUB_DEFAULTS, ...(getConfig().sources?.github ?? {}) });
  const host = () => new URL(settings().webUrl).host;

  async function post(url, form) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.error) throw new Error(`GitHub returned HTTP ${res.status}`);
    return body;
  }

  async function whoami(token) {
    const res = await fetchImpl(`${settings().apiUrl}/user`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'birddog' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error('GitHub rejected the token. Sign in again.');
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for /user`);
    const u = await res.json();
    return { login: u.login, name: u.name ?? null };
  }

  async function saveConnection(info) {
    const all = await readJson(file, {});
    if (info) all.github = info; else delete all.github;
    await writeJson(file, all);
  }

  async function pollDevice(flow) {
    const s = settings();
    let interval = flow.interval;
    while (flow.status === 'waiting') {
      await wait(interval * 1000);
      if (device !== flow || flow.status !== 'waiting') return;
      if (now() > flow.expiresAt) { flow.status = 'expired'; flow.error = 'The code expired. Start again.'; return; }
      let r;
      try {
        r = await post(`${s.webUrl}/login/oauth/access_token`, { client_id: s.clientId, device_code: flow.deviceCode, grant_type: DEVICE_GRANT });
      } catch (e) {
        flow.status = 'error'; flow.error = e.message; return;
      }
      if (r.access_token) {
        try {
          const me = await whoami(r.access_token);
          await secrets.set(SECRET, r.access_token);
          await saveConnection({ method: 'device', login: me.login, name: me.name, connectedAt: new Date(now()).toISOString() });
          flow.status = 'done';
          flow.login = me.login;
          notify();
        } catch (e) { flow.status = 'error'; flow.error = e.message; }
        return;
      }
      if (r.error === 'authorization_pending') continue;
      if (r.error === 'slow_down') { interval = (r.interval ?? interval + 5); continue; }
      flow.status = r.error === 'expired_token' ? 'expired' : 'error';
      flow.error = r.error === 'access_denied' ? 'You cancelled the sign-in on GitHub.' : (r.error_description || r.error || 'Sign-in failed');
      return;
    }
  }

  // In a container the token comes from GITHUB_TOKEN (a read-only secret store).
  let envLogin = null;
  const envToken = async () => (secrets.readOnly ? secrets.get(SECRET) : null);
  async function envConnection() {
    const token = await envToken();
    if (!token) return null;
    if (!envLogin) envLogin = await whoami(token).then((m) => m.login, () => null);
    return { method: 'env', login: envLogin, connectedAt: null };
  }

  return {
    /** What setup shows on the GitHub card. */
    async status() {
      const s = settings();
      const conn = (await readJson(file, {})).github ?? await envConnection();
      return {
        connected: !!conn,
        login: conn?.login ?? null,
        method: conn?.method ?? null,
        connectedAt: conn?.connectedAt ?? null,
        tokenFrom: secrets.readOnly ? (secrets.describe?.(SECRET) ?? null) : null,
        deviceFlowAvailable: !!s.clientId,
        host: host(),
        secretStore: secrets.kind,
        device: device && { status: device.status, userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt, error: device.error ?? null, login: device.login ?? null },
      };
    },

    /** Start the device flow. Returns the code to show the user. */
    async startDevice() {
      const s = settings();
      if (!s.clientId) {
        throw new Error('Device sign-in needs a GitHub OAuth App client ID in sources.github.clientId (see README), or use your gh CLI login.');
      }
      const r = await post(`${s.webUrl}/login/device/code`, { client_id: s.clientId, scope: s.scopes });
      if (r.error) throw new Error(r.error === 'device_flow_disabled' ? 'Enable "Device flow" in your GitHub OAuth App settings.' : (r.error_description || r.error));
      if (device) device.status = 'cancelled';
      device = {
        status: 'waiting',
        deviceCode: r.device_code,
        userCode: r.user_code,
        verificationUri: r.verification_uri,
        interval: Math.max(5, Number(r.interval) || 5),
        expiresAt: now() + (Number(r.expires_in) || 900) * 1000,
      };
      pollDevice(device);
      return (await this.status()).device;
    },

    /** Use the token gh already has. Stores no copy. */
    async useGhCli() {
      const token = await cliToken(host());
      const me = await whoami(token);
      await secrets.delete(SECRET).catch(() => {});
      await saveConnection({ method: 'gh-cli', login: me.login, name: me.name, connectedAt: new Date(now()).toISOString() });
      notify();
      return this.status();
    },

    /** A token for API calls (used by the GitHub source). */
    async token() {
      const conn = (await readJson(file, {})).github;
      if (!conn) return envToken();
      return conn.method === 'gh-cli' ? cliToken(host()) : secrets.get(SECRET);
    },

    async disconnect() {
      if (device) device.status = 'cancelled';
      device = null;
      await secrets.delete(SECRET).catch(() => {});
      await saveConnection(null);
      notify();
      return this.status();
    },
  };
}
