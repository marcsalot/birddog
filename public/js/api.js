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
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, scope: data.scope, status: res.status });
  return data;
}

const item = (id, action) => `/api/items/${encodeURIComponent(id)}/${action}`;

export const api = {
  items: () => call('GET', '/api/items'),
  refresh: () => call('POST', '/api/refresh', {}),
  done: (id) => call('POST', item(id, 'done'), {}),
  snooze: (id, until) => call('POST', item(id, 'snooze'), { until }),
  restore: (id) => call('POST', item(id, 'restore'), {}),
  message: (id) => call('GET', item(id, 'message')),
  replyDetails: (id) => call('GET', item(id, 'reply')),
  reply: (id, text, broadcast) => call('POST', item(id, 'reply'), { text, broadcast }),
  replyStatus: (pid) => call('GET', `/api/replies/${encodeURIComponent(pid)}`),
  replyUndo: (pid) => call('POST', `/api/replies/${encodeURIComponent(pid)}/undo`, {}),
  removeCalendar: (kind) => call('DELETE', `/api/sources/cal/calendars/${encodeURIComponent(kind)}`, {}),
  syncDone: (id, on) => call('PUT', `/api/sources/${encodeURIComponent(id)}/sync`, { on }),
  allowReplies: (id, allow) => call('PUT', `/api/sources/${encodeURIComponent(id)}/replies`, { allow }),
  prefs: () => call('GET', '/api/prefs'),
  savePrefs: (patch) => call('PUT', '/api/prefs', patch),
  setup: () => call('GET', '/api/setup'),
  firstRun: () => call('GET', '/api/firstrun'),
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
  chatConversation: (id) => call('GET', `/api/chat/conversations/${encodeURIComponent(id)}`),
  chatBoundaries: () => call('GET', '/api/chat/boundaries'),
  chatMemory: () => call('GET', '/api/chat/memory'),
  chatForget: (id) => call('DELETE', `/api/chat/memory/${encodeURIComponent(id)}`, {}),
  chatForgetAll: () => call('DELETE', '/api/chat/memory', {}),
  notifyClaim: (canShow) => call('POST', '/api/notifications/claim', { canShow }),
  notifyTest: (channel) => call('POST', '/api/notifications/test', channel ? { channel } : {}),
  notifyKinds: () => call('GET', '/api/notifications/kinds'),
  retrySource: (id) => call('POST', `/api/sources/${encodeURIComponent(id)}/retry`, {}),
  enableSource: (id, enabled) => call('PUT', `/api/sources/${encodeURIComponent(id)}/enabled`, { enabled }),
  disconnectSource: (id) => call('DELETE', `/api/sources/${encodeURIComponent(id)}`, {}),
  profiles: () => call('GET', '/api/profiles'),
  saveProfiles: (profiles) => call('PUT', '/api/profiles', { profiles }),
  resetProfiles: () => call('DELETE', '/api/profiles', {}),
  board: (fresh) => call('GET', `/api/board${fresh ? '?fresh=1' : ''}`),
  boardSettings: (s) => call('PUT', '/api/board/settings', s),
  boardReset: () => call('DELETE', '/api/board/settings', {}),
  workspace: (fresh) => call('GET', `/api/workspace${fresh ? '?fresh=1' : ''}`),
  workspaceSettings: (s) => call('PUT', '/api/workspace/settings', s),
  claimSlot: (kind, id, body) => call('PUT', `/api/workspace/slots/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, body),
  releaseSlot: (kind, id) => call('DELETE', `/api/workspace/slots/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {}),
  standup: async () => {
    let res;
    try { res = await fetch('/api/standup'); } catch { throw new Error('Birddog server is not reachable. Is it still running?'); }
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Request failed (${res.status})`); }
    return res.text();
  },
  me: () => call('GET', '/api/me'),
  logout: () => call('POST', '/auth/logout', {}),
  github: () => call('GET', '/api/connections/github'),
  githubDevice: () => call('POST', '/api/connections/github/device', {}),
  githubCli: () => call('POST', '/api/connections/github/gh-cli', {}),
  githubDisconnect: () => call('DELETE', '/api/connections/github', {}),
};
