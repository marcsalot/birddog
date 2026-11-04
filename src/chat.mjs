// "Ask Fetch": a chat that answers from your inbox.
//
// The local server calls the Claude Messages API with plain fetch (no SDK, no
// dependencies) and hands the model Birddog's own MCP tools. Reading tools run
// straight away; tools that change something (mark_done, snooze, restore) stop
// the turn and wait for you to confirm in the UI.
//
// Opt-in: nothing is sent anywhere until you add an Anthropic API key and agree
// that inbox content (titles, "why" lines, fields) goes to Anthropic.
// The key lives in your OS keychain ("anthropic-api-key"), or ANTHROPIC_API_KEY in
// Docker, and is never logged or returned by the API.

import crypto from 'node:crypto';
import { createMcpHandler } from './mcp.mjs';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const SECRET = 'anthropic-api-key';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
// Server-side refusal fallback, routed by refusal category (Claude API only).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 64_000;
const MAX_STEPS = 8; // model calls per user message
const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 2 * 3_600_000;
const CHANGES = new Set(['mark_done', 'snooze', 'restore']);

class ChatError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// Tool input validation (the subset of JSON Schema our tools use)

export function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const r of schema.required ?? []) if (!(r in input)) return `"${r}" is required`;
  for (const [k, v] of Object.entries(input)) {
    const p = schema.properties?.[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown field "${k}"`; continue; }
    if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `"${k}" must be a whole number`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
    if (p.minimum !== undefined && v < p.minimum) return `"${k}" must be at least ${p.minimum}`;
    if (p.maximum !== undefined && v > p.maximum) return `"${k}" must be at most ${p.maximum}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server-sent events from the Messages API

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

/** Stream one model response. Calls onText(text) as text arrives. Returns { content, stopReason, model }. */
export async function streamMessage({ fetchImpl, apiKey, request, onText = () => {}, signal }) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-beta': FALLBACK_BETA,
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal,
    });
  } catch {
    throw new ChatError('Could not reach api.anthropic.com. Are you offline?', 502);
  }
  if (!res.ok) {
    let msg = '';
    try { msg = JSON.parse(await res.text())?.error?.message ?? ''; } catch { /* not JSON */ }
    if (res.status === 401) throw new ChatError('Anthropic rejected the API key. Check it under Ask Fetch → Settings.', 502);
    if (res.status === 429) throw new ChatError('Anthropic is rate limiting this key. Try again in a minute.', 502);
    if (res.status === 529 || res.status >= 500) throw new ChatError('Anthropic is overloaded right now. Try again shortly.', 502);
    throw new ChatError(`Anthropic returned HTTP ${res.status}${msg ? `: ${msg}` : ''}`, 502);
  }
  const blocks = [];
  let stopReason = null;
  let model = request.model;
  for await (const ev of sseEvents(res.body)) {
    if (ev.type === 'message_start') model = ev.message?.model ?? model;
    else if (ev.type === 'content_block_start') {
      const b = { ...ev.content_block };
      if (b.type === 'tool_use') { b._json = ''; b.input = {}; }
      blocks[ev.index] = b;
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index];
      const d = ev.delta;
      if (d.type === 'text_delta') { b.text = (b.text ?? '') + d.text; onText(d.text); }
      else if (d.type === 'input_json_delta') b._json += d.partial_json;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    } else if (ev.type === 'content_block_stop') {
      const b = blocks[ev.index];
      if (b?.type === 'tool_use') {
        try { b.input = b._json ? JSON.parse(b._json) : {}; b._invalid = null; } catch { b._invalid = b._json; b.input = {}; }
      }
    } else if (ev.type === 'message_delta') stopReason = ev.delta?.stop_reason ?? stopReason;
    else if (ev.type === 'error') throw new ChatError(`Anthropic: ${ev.error?.message ?? 'stream error'}`, 502);
  }
  return { content: blocks.filter(Boolean), stopReason, model };
}

/**
 * What to send back as the assistant turn. After a mid-output fallback, blocks
 * before the last `fallback` marker that the fallback model can't continue from
 * (thinking, tool calls) are left out; text and everything after it stay.
 */
export function echoContent(content) {
  const clean = content.map(({ _json, _invalid, ...b }) => b);
  const last = clean.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return clean;
  return clean.filter((b, i) => i >= last || !['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(b.type));
}

// ---------------------------------------------------------------------------
// The chat service

const SYSTEM = (now) => `You are Fetch, Birddog's assistant (a dog that fetches answers). Birddog is the user's local "what needs me next?" inbox across local git, GitHub, Jira and their calendar. Each item says why it is there and how urgent it is (now, today, later).

Answer from the user's inbox using the tools: list_items, get_item and list_sources read it. Be concise and concrete: name items by title, say why they matter, and suggest what to do first when asked. Don't invent items, people or dates the tools didn't return.

mark_done, snooze and restore change Birddog's own list (never GitHub, Jira or git). Only use them when the user asks you to; the app then asks the user to confirm each change before it happens. If they decline, accept that and don't retry.

Now is ${new Date(now).toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`;

/**
 * @param {object} o
 * @param {object} o.app            the Birddog app (for the MCP tools)
 * @param {object} o.secrets        secret store (the API key)
 * @param {() => object} o.getPrefs prefs (chat consent)
 * @param {(patch) => Promise} o.setPrefs
 * @param {() => object} o.getConfig
 */
export function createChat({ app, secrets, getPrefs, setPrefs, getConfig, fetchImpl = fetch, version = '0', now = () => Date.now() }) {
  const mcp = createMcpHandler({ app, version, now });
  const toolDefs = mcp.tools;
  const sessions = new Map(); // id → { messages, pending, at }

  const model = () => process.env.BIRDDOG_CHAT_MODEL || getConfig().chat?.model || DEFAULT_MODEL;
  const tools = () => toolDefs.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true }));
  const apiKey = async () => (await secrets.get(SECRET).catch(() => null)) || null;

  async function status() {
    const key = await apiKey();
    const from = secrets.describe?.(SECRET) ?? null;
    return {
      enabled: !!key && !!getPrefs().chatConsent,
      hasKey: !!key,
      keyFrom: key ? (secrets.readOnly ? from?.from ?? 'environment' : secrets.kind) : null,
      keyVariable: secrets.readOnly ? from?.variable ?? 'ANTHROPIC_API_KEY' : null,
      consented: !!getPrefs().chatConsent,
      model: model(),
      ...(getConfig().chat?.demo ? { demo: true } : {}),
    };
  }

  async function setup({ apiKey: key, consent }) {
    if (consent !== true) throw new ChatError('Agree that inbox content is sent to Anthropic to turn Ask Fetch on.');
    if (key !== undefined && key !== '') {
      if (typeof key !== 'string' || !/^[\x21-\x7e]{20,300}$/.test(key.trim())) throw new ChatError('That does not look like an Anthropic API key.');
      try { await secrets.set(SECRET, key.trim()); } catch (e) { throw new ChatError(e.message); }
    }
    if (!(await apiKey())) throw new ChatError(secrets.readOnly ? 'Set ANTHROPIC_API_KEY for this container and restart it.' : 'Paste an Anthropic API key.');
    await setPrefs({ chatConsent: true });
    return status();
  }

  async function turnOff({ forgetKey = true } = {}) {
    await setPrefs({ chatConsent: false });
    if (forgetKey) await secrets.delete(SECRET).catch(() => {});
    sessions.clear();
    return status();
  }

  function session(id) {
    const t = now();
    for (const [k, s] of sessions) if (t - s.at > SESSION_TTL_MS) sessions.delete(k);
    if (id && sessions.has(id)) { const s = sessions.get(id); s.at = t; return s; }
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const s = { id: crypto.randomUUID(), messages: [], pending: null, at: t };
    sessions.set(s.id, s);
    return s;
  }

  const callTool = async (name, input) => {
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } });
    if (r.error) return { text: r.error.message, isError: true };
    return { text: r.result.content.map((c) => c.text).join('\n'), isError: !!r.result.isError, structured: r.result.structuredContent };
  };

  /** Plain-language line for a change awaiting confirmation. */
  async function describeChange(name, input) {
    const r = await callTool('get_item', { id: input.id });
    const title = r.structured?.item?.title ?? input.id;
    if (name === 'mark_done') return `Mark done: ${title}`;
    if (name === 'restore') return `Put back in the open list: ${title}`;
    return `Snooze until ${input.until}: ${title}`;
  }

  /** Run the model/tool loop until the model is done or a change needs confirming. emit(event) streams to the UI. */
  async function run(s, emit, signal) {
    const key = await apiKey();
    for (let step = 0; step < MAX_STEPS; step++) {
      const { content, stopReason } = await streamMessage({
        fetchImpl, apiKey: key, signal,
        request: {
          model: model(),
          max_tokens: MAX_TOKENS,
          system: SYSTEM(now()),
          tools: tools(),
          messages: s.messages,
          output_config: { effort: 'medium' },
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
        },
        onText: (text) => emit({ type: 'text', text }),
      });
      if (stopReason === 'refusal') {
        emit({ type: 'error', message: 'Claude declined to answer that. Try asking differently.' });
        return;
      }
      s.messages.push({ role: 'assistant', content: echoContent(content) });
      const uses = content.filter((b) => b.type === 'tool_use');
      if (stopReason !== 'tool_use' || !uses.length) {
        if (stopReason === 'max_tokens') emit({ type: 'error', message: 'The answer was cut off.' });
        return;
      }
      const results = [];
      const pending = [];
      for (const u of uses) {
        const def = toolDefs.find((t) => t.name === u.name);
        const invalid = u._invalid !== undefined && u._invalid !== null ? 'the tool input was not valid JSON' : !def ? `no tool called ${u.name}` : validateInput(def.inputSchema, u.input);
        if (invalid) { results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `INVALID_INPUT: ${invalid}` }); continue; }
        if (CHANGES.has(u.name)) {
          pending.push({ id: u.id, name: u.name, input: u.input, summary: await describeChange(u.name, u.input) });
          continue;
        }
        emit({ type: 'tool', name: u.name, input: u.input });
        const r = await callTool(u.name, u.input);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
      }
      if (pending.length) {
        s.pending = { results, changes: pending };
        for (const p of pending) emit({ type: 'confirm', id: p.id, name: p.name, summary: p.summary });
        return;
      }
      s.messages.push({ role: 'user', content: results });
    }
    emit({ type: 'error', message: 'Stopped after too many steps.' });
  }

  /**
   * Errors we can explain become an `error` event; then always `done`.
   * The conversation must never end in an unanswered tool call, so a trailing
   * assistant turn with tool calls is dropped (the API never saw it come back).
   */
  async function runSafely(s, emit, signal) {
    try {
      await run(s, emit, signal);
    } catch (err) {
      const last = s.messages.at(-1);
      if (last?.role === 'assistant' && last.content.some((b) => b.type === 'tool_use') && !s.pending) s.messages.pop();
      if (!(err instanceof ChatError)) { emit({ type: 'done' }); throw err; }
      emit({ type: 'error', message: err.message });
    }
    emit({ type: 'done' });
  }

  return {
    status,
    setup,
    turnOff,
    /** Send a message. emit(event) is called with {type:'session'|'text'|'tool'|'confirm'|'error'|'done'}. */
    async send({ sessionId, message }, emit, signal) {
      const st = await status();
      if (!st.enabled) throw new ChatError('Ask Fetch is off. Add an API key and agree to send inbox content to Anthropic first.', 409);
      if (typeof message !== 'string' || !message.trim() || message.length > 8000) throw new ChatError('Type a question (up to 8000 characters).');
      const s = session(sessionId);
      if (s.pending) throw new ChatError('Confirm or cancel the pending change first.', 409);
      emit({ type: 'session', id: s.id });
      s.messages.push({ role: 'user', content: message.trim() });
      await runSafely(s, emit, signal);
    },
    /** Answer pending changes: decisions = { toolUseId: true|false }. Approved ones run; then the model continues. */
    async confirm({ sessionId, decisions }, emit, signal) {
      const s = sessions.get(sessionId);
      if (!s?.pending) throw new ChatError('Nothing is waiting for confirmation.', 409);
      const { results, changes } = s.pending;
      s.pending = null;
      for (const c of changes) {
        if (decisions?.[c.id] === true) {
          const r = await callTool(c.name, c.input);
          emit({ type: 'changed', id: c.id, summary: c.summary, ok: !r.isError });
          results.push({ type: 'tool_result', tool_use_id: c.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
        } else {
          emit({ type: 'declined', id: c.id, summary: c.summary });
          results.push({ type: 'tool_result', tool_use_id: c.id, content: 'The user declined this change. Do not retry it.' });
        }
      }
      s.messages.push({ role: 'user', content: results });
      await runSafely(s, emit, signal);
    },
    reset(sessionId) { sessions.delete(sessionId); },
  };
}

export { ChatError };
