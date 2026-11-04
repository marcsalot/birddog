// Thin wrapper over Birddog's local JSON API.

async function call(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Birddog server is not reachable. Is it still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Login is on and the session ended: go sign in, then come back here.
    location.assign(`/auth/login?returnTo=${encodeURIComponent(location.pathname)}`);
    throw new Error('Signing you in again…');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const item = (id, action) => `/api/items/${encodeURIComponent(id)}/${action}`;

export const api = {
  items: () => call('GET', '/api/items'),
  refresh: () => call('POST', '/api/refresh', {}),
  done: (id) => call('POST', item(id, 'done'), {}),
  snooze: (id, until) => call('POST', item(id, 'snooze'), { until }),
  restore: (id) => call('POST', item(id, 'restore'), {}),
  prefs: () => call('GET', '/api/prefs'),
  savePrefs: (patch) => call('PUT', '/api/prefs', patch),
  setup: () => call('GET', '/api/setup'),
  testSource: (id, settings) => call('POST', `/api/sources/${encodeURIComponent(id)}/test`, settings),
  saveSource: (id, settings) => call('PUT', `/api/sources/${encodeURIComponent(id)}`, settings),
  oauth: () => call('GET', '/api/oauth'),
  oauthStart: (p) => call('POST', `/api/oauth/${encodeURIComponent(p)}/start`, {}),
  oauthOff: (p) => call('DELETE', `/api/oauth/${encodeURIComponent(p)}`, {}),
  history: (days = 14) => call('GET', `/api/history?days=${days}`),
  chatStatus: () => call('GET', '/api/chat/status'),
  chatSetup: (body) => call('POST', '/api/chat/setup', body),
  chatOff: () => call('DELETE', '/api/chat/setup', {}),
  chatReset: (sessionId) => call('POST', '/api/chat/reset', { sessionId }),
  notifyClaim: (canShow) => call('POST', '/api/notifications/claim', { canShow }),
  notifyTest: (channel) => call('POST', '/api/notifications/test', channel ? { channel } : {}),
  notifyKinds: () => call('GET', '/api/notifications/kinds'),
  retrySource: (id) => call('POST', `/api/sources/${encodeURIComponent(id)}/retry`, {}),
  enableSource: (id, enabled) => call('PUT', `/api/sources/${encodeURIComponent(id)}/enabled`, { enabled }),
  disconnectSource: (id) => call('DELETE', `/api/sources/${encodeURIComponent(id)}`, {}),
  me: () => call('GET', '/api/me'),
  logout: () => call('POST', '/auth/logout', {}),
  github: () => call('GET', '/api/connections/github'),
  githubDevice: () => call('POST', '/api/connections/github/device', {}),
  githubCli: () => call('POST', '/api/connections/github/gh-cli', {}),
  githubDisconnect: () => call('DELETE', '/api/connections/github', {}),
};
