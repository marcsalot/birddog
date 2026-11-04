// Replying from Birddog: the one place it writes to another service.
//
// A source opts in with the "reply" capability:
//
//   export const capabilities = ['reply'];
//   export function replyTarget(item)  → { label, to, where, thread, canBroadcast } | null
//                                         who and where a reply goes (no network)
//   export async function reply(item, text, ctx, { broadcast }) → { ok: true, url? }
//                                         post it; throw ReplyError for problems the user can fix
//   export async function replyCheck(ctx) → { missingScope?: string } (optional, before typing)
//
// Slack is the first. Teams, Discord or Google Chat plug in the same way; so could
// PR or ticket comments (GitHub, GitLab, Jira) later.
//
// Writing is opt-in per source: nothing posts until `sources.<id>.allowReplies` is true
// (the "Allow replies" switch on the source's card). Replies typed in the dashboard wait
// UNDO_MS before they go out, so "Undo send" can stop them. Fetch and MCP send at once,
// but only after their own confirmation (Fetch) or opt-in (mcp.allowReplies).

import crypto from 'node:crypto';

export const MAX_REPLY = 4000; // characters; Slack truncates long messages at 40k, but a reply is short
export const UNDO_MS = 5_000;
const KEEP_MS = 10 * 60_000; // finished sends stay readable this long (the page polls for the result)
const CHECK_TTL_MS = 5 * 60_000;

export class ReplyError extends Error {
  /** code: missing_scope | rate_limited | not_allowed | invalid | gone | failed */
  constructor(message, { code = 'failed', status = 400, scope, retryAfter } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    if (scope) this.scope = scope;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

export const canReply = (src) => Array.isArray(src?.capabilities) && src.capabilities.includes('reply') && typeof src.reply === 'function' && typeof src.replyTarget === 'function';

/** Trim, check length, drop control characters other than newlines and tabs. */
export function cleanReply(text) {
  if (typeof text !== 'string') throw new ReplyError('Type a reply first.', { code: 'invalid' });
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!t) throw new ReplyError('Type a reply first.', { code: 'invalid' });
  if (t.length > MAX_REPLY) throw new ReplyError(`Replies can be up to ${MAX_REPLY} characters (this one is ${t.length}).`, { code: 'invalid' });
  return t;
}

/**
 * @param {object} o
 * @param {Array} o.sources
 * @param {() => object} o.getConfig
 * @param {(id) => object} o.findItem     the current item with that id (throws if gone)
 * @param {object} o.context              what sources get in ctx (fetch, secret, …)
 * @param {(item) => Promise} o.onSent    e.g. mark the item done
 */
export function createReplies({ sources, getConfig, findItem, context, onSent = async () => {}, log = console, now = () => Date.now(), undoMs = UNDO_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map(); // id → { state, itemId, text, broadcast, sendsAt, timer, result, error, at }
  const checks = new Map(); // source id → { at, value }

  const srcOf = (item) => sources.find((s) => s.id === item.source);
  const allowed = (src) => getConfig().sources?.[src.id]?.allowReplies === true;

  /** What the dashboard shows for an item: null when its source can't reply. */
  function target(item) {
    const src = srcOf(item);
    if (!canReply(src)) return null;
    const t = src.replyTarget(item);
    if (!t) return null;
    return { ...t, allowed: allowed(src), maxLength: MAX_REPLY };
  }

  /** The target plus a one-off check (e.g. the token's scopes), cached for a few minutes. */
  async function details(item) {
    const t = target(item);
    if (!t) throw new ReplyError(`${item.source} items can't be answered from Birddog.`, { code: 'not_allowed' });
    const src = srcOf(item);
    if (t.allowed && src.replyCheck) {
      let c = checks.get(src.id);
      if (!c || now() - c.at > CHECK_TTL_MS) {
        c = { at: now(), value: await src.replyCheck({ ...context, now: now() }).catch(() => ({})) };
        checks.set(src.id, c);
      }
      return { ...t, ...c.value };
    }
    return t;
  }

  /** Send right away (Fetch after you confirm, MCP when allowed). Returns { ok, url }. */
  async function sendNow(itemId, text, { broadcast = false, mentions = false } = {}) {
    const item = findItem(itemId);
    const src = srcOf(item);
    if (!canReply(src) || !src.replyTarget(item)) throw new ReplyError(`${item.source} items can't be answered from Birddog.`, { code: 'not_allowed' });
    if (!allowed(src)) throw new ReplyError(`Replies are off for ${src.name}. Turn on "Allow replies" on its card in Sources & settings.`, { code: 'not_allowed', status: 403 });
    const clean = cleanReply(text);
    let r;
    try {
      r = await src.reply(item, clean, { ...context, now: now() }, { broadcast: !!broadcast, mentions: !!mentions });
    } catch (err) {
      if (err instanceof ReplyError) {
        if (err.code === 'missing_scope') checks.set(src.id, { at: now(), value: { missingScope: err.scope } });
        throw err;
      }
      log.warn?.(`birddog: reply via ${src.id} failed: ${err.message}`);
      throw new ReplyError(`${src.name} didn't take the reply: ${err.message}`);
    }
    await onSent(item).catch((e) => log.warn?.(`birddog: reply sent, but clearing the item failed: ${e.message}`));
    return { ok: true, url: r?.url ?? null };
  }

  const view = (id, p) => ({ id, state: p.state, itemId: p.itemId, sendsAt: new Date(p.sendsAt).toISOString(), ...(p.result ? { url: p.result.url } : {}), ...(p.error ? { error: p.error } : {}), ...(p.state === 'undone' ? { text: p.text } : {}) });

  function sweep() {
    for (const [k, p] of pending) if (p.state !== 'pending' && now() - p.at > KEEP_MS) pending.delete(k);
  }

  return {
    target,
    details,
    sendNow,
    /** Queue a reply from the dashboard. It goes out after undoMs unless undone. */
    queue(itemId, text, { broadcast = false } = {}) {
      sweep();
      const item = findItem(itemId);
      const t = target(item);
      if (!t) throw new ReplyError(`${item.source} items can't be answered from Birddog.`, { code: 'not_allowed' });
      if (!t.allowed) throw new ReplyError(`Replies are off for this source. Turn on "Allow replies" on its card in Sources & settings.`, { code: 'not_allowed', status: 403 });
      const clean = cleanReply(text);
      if ([...pending.values()].some((p) => p.state === 'pending' && p.itemId === itemId)) throw new ReplyError('A reply to this item is already on its way. Undo it first.', { code: 'invalid', status: 409 });
      const id = crypto.randomUUID();
      const p = { state: 'pending', itemId, text: clean, broadcast: !!broadcast && !!t.canBroadcast, sendsAt: now() + undoMs, at: now() };
      p.timer = setTimer(async () => {
        if (p.state !== 'pending') return;
        p.state = 'sending';
        try {
          // Typed in the dashboard by you, so @channel / @here you typed are honoured.
          p.result = await sendNow(itemId, p.text, { broadcast: p.broadcast, mentions: true });
          p.state = 'sent';
        } catch (err) {
          p.state = 'failed';
          p.error = { message: err.message, code: err.code ?? 'failed', ...(err.scope ? { scope: err.scope } : {}) };
        }
        p.at = now();
      }, undoMs);
      p.timer?.unref?.();
      pending.set(id, p);
      return view(id, p);
    },
    /** Stop a queued reply. Returns its text so the box can show it again. */
    undo(id) {
      const p = pending.get(id);
      if (!p) throw new ReplyError('That reply is gone.', { code: 'gone', status: 404 });
      if (p.state !== 'pending') throw new ReplyError(p.state === 'undone' ? 'Already undone.' : 'Too late: it has already gone out.', { code: 'invalid', status: 409 });
      clearTimer(p.timer);
      p.state = 'undone';
      p.at = now();
      return view(id, p);
    },
    get(id) {
      const p = pending.get(id);
      if (!p) throw new ReplyError('That reply is gone.', { code: 'gone', status: 404 });
      return view(id, p);
    },
    close() { for (const p of pending.values()) clearTimer(p.timer); pending.clear(); },
  };
}
