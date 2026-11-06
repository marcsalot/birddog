// `birddog mcp`: a Model Context Protocol server over stdio, so AI tools
// (Claude Code, Claude Desktop, …) can ask "what needs me?" and triage items.
//
// Hand-rolled JSON-RPC 2.0, one message per line, no dependencies.
// It reads the same files as the dashboard (cache.json for items, state.json for
// done/snooze), so both can run at once. When the cached data is old (the
// dashboard isn't running) it refreshes the sources itself.
//
// What it exposes: items (title, why, urgency, link, fields) and source health.
// What it never exposes: tokens, secrets, settings or your config.
//
// One tool writes outside Birddog: `reply` posts a message AS YOU (e.g. in Slack).
// It's hidden and refused unless config.json has "mcp": { "allowReplies": true }, the
// source's own "Allow replies" switch is on, and it posts exactly the text in the call.

import readline from 'node:readline';

const plain = (s) => String(s ?? '').replace(/\*\*/g, '');

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const URGENCY = ['now', 'today', 'later'];
const STATUS = ['open', 'snoozed', 'done', 'all'];
const MAX_LIMIT = 200;

const ERR = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 };

class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Tools

const TOOLS = [
  {
    name: 'list_items',
    title: 'What needs me?',
    description: 'List what needs the user\'s attention across every connected source (git, GitHub, GitLab, Jira, Linear, Slack, calendar and the rest; list_sources says which are on), most urgent first. Each item says why it is there. Filter by urgency (now, today, later), source id, status, or words in the item (query).',
    inputSchema: {
      type: 'object',
      properties: {
        urgency: { type: 'string', enum: URGENCY, description: 'Only this urgency group' },
        source: { type: 'string', description: 'Only this source id, e.g. git, github, gitlab, jira, linear, slack, cal (see list_sources)' },
        query: { type: 'string', description: 'Only items whose title, why line or fields contain these words (case-insensitive)' },
        status: { type: 'string', enum: STATUS, description: 'open (default): not done or snoozed; all: everything' },
        profile: { type: 'string', description: 'Which profile to look in: "auto" or omitted = the one the dashboard shows (Work, Home…), "all" = every source, or a profile id' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'At most this many items (default 50)' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_item',
    title: 'Item details',
    description: 'Everything Birddog knows about one item: why it is there, the rule that ranked it, its fields, link and suggested next step.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Item id from list_items' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_sources',
    title: 'Source health',
    description: 'Which sources are connected, how many items each has, and which are stale (failed to refresh) with the error.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'mark_done',
    title: 'Mark done',
    description: 'Mark an item done in Birddog. It disappears from the open list until it changes (new commits, new activity). Only changes Birddog\'s own list, never GitHub, Jira or git. The one exception: tasks from a task list (Microsoft To Do, Google Tasks, Todoist) whose source has "Sync done" switched on are completed in that app too.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'snooze',
    title: 'Snooze',
    description: 'Hide an item in Birddog until a time. until: "1h", "3h", "2d", "tomorrow" (9:00), "next-week" (Monday 9:00), "change" (until the item changes), or an ISO date in the future.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, until: { type: 'string', description: '1h | 3h | 2d | tomorrow | next-week | change | ISO date' } },
      required: ['id', 'until'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'restore',
    title: 'Undo done or snooze',
    description: 'Put a done or snoozed item back in the open list.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Posts as the user, so it's only listed when config allows it (mcp.allowReplies). */
const REPLY_TOOL = {
  name: 'reply',
  title: 'Reply as the user',
  description: 'Post a reply AS THE USER to an item whose source can reply (Slack DMs and mentions; see "reply" in list_items). DMs get the reply in the DM; channel mentions get it in the thread. This sends a real message that other people will read, so only use it when the user asked you to send that exact text. Birddog posts exactly `text`, as plain text (no @channel/@here), and then clears the item.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item id from list_items' },
      text: { type: 'string', description: 'The exact message to post (up to 4000 characters)' },
      also_send_to_channel: { type: 'boolean', description: 'For a thread reply: also show it in the channel (default false)' },
    },
    required: ['id', 'text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

/** Resolve a snooze target to an ISO date (or "change"). Exported for tests. */
export function snoozeUntil(input, now = Date.now()) {
  const v = String(input ?? '').trim().toLowerCase();
  if (v === 'change') return 'change';
  const rel = /^(\d{1,3})\s*([hd])$/.exec(v);
  if (rel) return new Date(now + Number(rel[1]) * (rel[2] === 'h' ? 3_600_000 : 86_400_000)).toISOString();
  const d = new Date(now);
  if (v === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); }
  if (v === 'next-week' || v === 'next week') { d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); d.setHours(9, 0, 0, 0); return d.toISOString(); }
  const t = Date.parse(input);
  if (!Number.isNaN(t) && t > now) return new Date(t).toISOString();
  throw new ToolError('until must be 1h, 3h, 2d, tomorrow, next-week, change, or a future ISO date');
}

/** The fields of an item that are safe and useful to hand to a model. */
export function publicItem(i) {
  return {
    id: i.id,
    source: i.source,
    kind: i.kind,
    title: i.title,
    why: plain(i.why),
    urgency: i.urgency,
    status: i.status ?? 'open',
    url: i.url,
    updatedAt: i.updatedAt,
    ...(i.snoozedUntil ? { snoozedUntil: i.snoozedUntil } : {}),
    ...(i.doneAt ? { doneAt: i.doneAt } : {}),
    ...(i.stale ? { stale: { since: new Date(i.stale.since).toISOString(), error: i.stale.error } } : {}),
    rule: i.meta?.rule?.text ?? null,
    nextStep: i.meta?.command ?? null,
    fields: i.meta?.fields ?? {},
    ...(i.reply ? { reply: { to: i.reply.label, allowed: !!i.reply.allowed } } : {}),
  };
}

const publicSource = (s) => ({
  id: s.id, name: s.name, status: s.status, items: s.count,
  lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
  ...(s.status === 'stale' ? { staleSince: new Date(s.staleSince).toISOString(), error: s.error, failures: s.failures } : {}),
  summary: s.summary,
});

/** Every word of the query appears somewhere in the item (title, why, source, fields). */
function matches(item, query) {
  if (query === undefined || query === null || !String(query).trim()) return true;
  const hay = [item.title, item.why, item.source, item.kind, ...Object.entries(item.fields ?? {}).flat()].join(' ').toLowerCase();
  return String(query).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const line = (i) => `- [${i.urgency}${i.status !== 'open' ? `, ${i.status}` : ''}] ${i.title}\n  ${i.why}${i.stale ? ' (stale data)' : ''}\n  id: ${i.id}${i.url ? `\n  ${i.url}` : ''}`;

/**
 * The protocol, without any I/O: give it a parsed message, get the reply (or null).
 * `app` is a Birddog app from createBirddog() (it is never started; nothing listens).
 */
export function createMcpHandler({ app, version, now = () => Date.now(), refreshAfterMs, allowReplies }) {
  // Chat (Fetch) passes allowReplies: true, because it asks you to confirm each send itself.
  const repliesOn = () => !!app.replies && !!(typeof allowReplies === 'function' ? allowReplies() : allowReplies ?? (app.config.mcp?.allowReplies === true));
  const toolList = () => (repliesOn() ? [...TOOLS, REPLY_TOOL] : TOOLS);
  let fresh = null; // promise of the first refresh, if the cache was old

  async function data() {
    if (!app.collector.refreshing) await app.collector.load(); // pick up what the dashboard wrote
    const maxAge = refreshAfterMs ?? Math.max(1, Number(app.config.refreshMinutes) || 5) * 2 * 60_000;
    if (!app.collector.refreshedAt || now() - app.collector.refreshedAt > maxAge) {
      fresh ??= app.refresh().catch(() => {}).finally(() => { fresh = null; });
      await fresh;
    }
    await app.triage.sync();
    const snap = app.collector.snapshot();
    const items = app.triage.apply(snap.items).map((i) => { const r = app.replies?.target(i); return r ? { ...i, reply: r } : i; });
    return { items, sources: snap.sources };
  }

  async function find(id) {
    if (typeof id !== 'string' || !id) throw new ToolError('id is required');
    const { items } = await data();
    const it = items.find((i) => i.id === id);
    if (!it) throw new ToolError(`No item with id "${id}". Call list_items for current ids.`);
    return it;
  }

  const result = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) });

  const tools = {
    async list_items(a) {
      if (a.urgency !== undefined && !URGENCY.includes(a.urgency)) throw new ToolError(`urgency must be one of ${URGENCY.join(', ')}`);
      if (a.status !== undefined && !STATUS.includes(a.status)) throw new ToolError(`status must be one of ${STATUS.join(', ')}`);
      const limit = a.limit === undefined ? 50 : Number(a.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ToolError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
      if (a.profile !== undefined && (typeof a.profile !== 'string' || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(a.profile))) throw new ToolError('profile must be auto, all or a profile id');
      let { items, sources } = await data();
      // Asking for one source by id looks there whatever the profile.
      const profile = app.profiles && a.source === undefined ? app.profiles.active(a.profile && a.profile !== 'auto' ? a.profile : undefined) : null;
      if (profile?.sources) {
        items = items.filter((i) => profile.sources.includes(i.source));
        sources = sources.filter((s) => profile.sources.includes(s.id));
      }
      if (a.source !== undefined && !sources.some((s) => s.id === a.source)) {
        throw new ToolError(`No source "${a.source}" is switched on. Sources: ${sources.map((s) => s.id).join(', ') || 'none'}`);
      }
      const status = a.status ?? 'open';
      const list = items
        .filter((i) => (status === 'all' || i.status === status) && (!a.urgency || i.urgency === a.urgency) && (!a.source || i.source === a.source))
        .map(publicItem)
        .filter((i) => matches(i, a.query));
      const shown = list.slice(0, limit);
      const stale = sources.filter((s) => s.status === 'stale');
      const where = profile?.sources ? ` (${profile.name} profile; profile "all" shows every source)` : '';
      const head = shown.length
        ? `${list.length} ${status === 'all' ? '' : `${status} `}item${list.length === 1 ? '' : 's'}${list.length > shown.length ? ` (showing ${shown.length})` : ''}, most urgent first${where}:`
        : `Nothing needs you right now${where}.`;
      const note = stale.length ? `\n\nStale sources (showing their last good data): ${stale.map((s) => `${s.name}: ${s.error}`).join('; ')}` : '';
      return result(`${head}\n${shown.map(line).join('\n')}${note}`.trim(), { items: shown, total: list.length });
    },
    async get_item(a) {
      const it = publicItem(await find(a.id));
      const fields = Object.entries(it.fields).map(([k, v]) => `  ${k}: ${v}`).join('\n');
      return result(`${it.title}\nWhy: ${it.why}\nUrgency: ${it.urgency} (${it.rule ?? 'no rule'})\nStatus: ${it.status}${it.url ? `\nLink: ${it.url}` : ''}${it.nextStep ? `\nNext step: ${it.nextStep}` : ''}${fields ? `\n${fields}` : ''}`, { item: it });
    },
    async list_sources() {
      const { sources } = await data();
      const out = sources.map(publicSource);
      const text = out.map((s) => `- ${s.name} (${s.id}): ${s.status}, ${s.items} item${s.items === 1 ? '' : 's'}${s.error ? ` · ${s.error}` : s.summary ? ` · ${s.summary}` : ''}`).join('\n');
      return result(text || 'No sources are switched on. Open Birddog\'s setup to connect some.', { sources: out });
    },
    async mark_done(a) {
      const it = await find(a.id);
      let r = {};
      try { r = app.markDone ? await app.markDone(it) : (await app.triage.done(it), {}); } catch (e) { throw new ToolError(e.message); }
      return result(`Marked done: ${it.title}.${r.synced ? ` Also completed in ${r.synced}.` : ' It comes back if it changes.'}`, { id: it.id, status: 'done', ...(r.synced ? { completedIn: r.synced } : {}) });
    },
    async snooze(a) {
      const it = await find(a.id);
      const until = snoozeUntil(a.until, now());
      await app.triage.snooze(it, until);
      return result(`Snoozed until ${until === 'change' ? 'it changes' : new Date(until).toLocaleString()}: ${it.title}`, { id: it.id, status: 'snoozed', until });
    },
    async reply(a) {
      if (!repliesOn()) throw new ToolError('Replies through MCP are off. The user can turn them on with "mcp": { "allowReplies": true } in config.json.');
      if (typeof a.text !== 'string') throw new ToolError('text is required');
      const it = await find(a.id);
      if (!it.reply) throw new ToolError(`${it.source} items can't be answered from Birddog.`);
      try {
        const r = await app.replies.sendNow(it.id, a.text, { broadcast: a.also_send_to_channel === true, mentions: false });
        return result(`Sent as the user (${it.reply.label}).${r.url ? ` ${r.url}` : ''} The item is cleared.`, { id: it.id, sent: true, url: r.url });
      } catch (err) { throw new ToolError(err.message); }
    },
    async restore(a) {
      const it = await find(a.id);
      try { if (app.restoreItem) await app.restoreItem(it.id); else await app.triage.restore(it.id); } catch (e) { throw new ToolError(e.message); }
      return result(`Back in the open list: ${it.title}`, { id: it.id, status: 'open' });
    },
  };

  async function call(method, params) {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'birddog', title: 'Birddog', version },
          instructions: 'Birddog is the user\'s local "what needs me next?" inbox across every source they connect (git, GitHub, GitLab, Jira, Linear, Slack, calendar and more). Use list_items to see what needs them (each item explains why), get_item for details, and mark_done or snooze only when the user asks. Triage only changes Birddog\'s own list.',
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: toolList() };
      case 'tools/call': {
        const fn = params?.name === 'reply' && !repliesOn() ? null : tools[params?.name];
        if (!fn) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: ERR.params });
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('arguments must be an object'), { code: ERR.params });
        try {
          return await fn(args);
        } catch (err) {
          // Tool failures are results the model can read, not protocol errors.
          return { content: [{ type: 'text', text: err instanceof ToolError ? err.message : `Birddog hit an error: ${err.message}` }], isError: true };
        }
      }
      default: throw Object.assign(new Error(`Method not found: ${method}`), { code: ERR.method });
    }
  }

  /** Handle one parsed JSON-RPC message (or a batch). Returns the reply, or null for notifications. */
  async function handle(msg) {
    if (Array.isArray(msg)) {
      const replies = (await Promise.all(msg.map(handle))).filter(Boolean);
      return replies.length ? replies : null;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.id !== undefined && ('result' in msg || 'error' in msg)) return null; // a reply to us; we send no requests
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: ERR.request, message: 'Invalid JSON-RPC request' } };
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const res = await call(msg.method, msg.params);
      return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result: res };
    } catch (err) {
      if (isNotification) return null; // e.g. notifications/initialized, notifications/cancelled
      return { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? ERR.internal, message: err.message } };
    }
  }

  return { handle, get tools() { return toolList(); } };
}

/** Run over stdio: newline-delimited JSON on stdin/stdout. Logs go to stderr only. */
export function serveStdio(handler, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
  let queue = Promise.resolve();
  rl.on('line', (text) => {
    if (!text.trim()) return;
    let msg;
    try { msg = JSON.parse(text); } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'Parse error: send one JSON message per line' } });
      return;
    }
    // In order, one at a time: triage writes stay predictable.
    queue = queue.then(() => handler.handle(msg)).then(write, (err) => write({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: ERR.internal, message: err.message } }));
  });
  return new Promise((resolve) => rl.on('close', () => queue.then(resolve)));
}
