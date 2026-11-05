// Fetch's memory: short notes you ask it to keep ("Priya is my manager", "standup
// items first"), and the conversations themselves, so a reload or restart picks up
// where you left off.
//
// Both live in Birddog's config folder, on this machine only:
//   memory.json        the notes (at most MAX_NOTES, each up to MAX_NOTE characters)
//   chat-history.json  recent conversations (at most MAX_KEPT, dropped after KEEP_DAYS)
//
// Notes go to Anthropic with each new conversation (that's how Fetch "remembers"),
// so the same consent covers them. A boundary: notes that look like a secret (API
// keys, tokens, passwords) are refused, never saved.

import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

export const MAX_NOTES = 50;
export const MAX_NOTE = 300;
const MAX_KEPT = 20;
const KEEP_DAYS = 7;

const SECRET_PATTERNS = [
  /\bsk-ant-[\w-]{8,}/i, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/, // other API keys in that style
  /\bxox[abposr]-[\w-]{8,}/i, // Slack
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /\bgithub_pat_\w{20,}/, // GitHub
  /\bglpat-[\w-]{16,}/, // GitLab
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key
  /\bya29\.[\w-]{20,}/, // Google access token
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passcode|pin|secret|api[ _-]?key|token)\s*(?:is|=|:)\s*\S{4,}/i,
  /\b[A-Za-z0-9+/_-]{40,}\b/, // any long opaque string
];

/** True when a note looks like it holds a secret. */
export const looksSecret = (text) => SECRET_PATTERNS.some((re) => re.test(String(text)));

export class MemoryError extends Error {}

export function createMemory({ dir, now = () => Date.now() }) {
  const notesFile = path.join(dir, 'memory.json');
  const historyFile = path.join(dir, 'chat-history.json');

  const loadNotes = async () => {
    const d = await readJson(notesFile, { notes: [] });
    return Array.isArray(d.notes) ? d.notes.filter((n) => n && typeof n.text === 'string' && typeof n.id === 'string') : [];
  };

  return {
    async notes() { return loadNotes(); },
    /** Save a note. Throws MemoryError (the message says why) for secrets, empty or too long notes, or a full memory. */
    async remember(text) {
      const t = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!t) throw new MemoryError('Nothing to remember.');
      if (t.length > MAX_NOTE) throw new MemoryError(`Notes can be up to ${MAX_NOTE} characters.`);
      if (looksSecret(t)) throw new MemoryError('That looks like a password, key or token. Fetch never stores secrets.');
      const notes = await loadNotes();
      const same = notes.find((n) => n.text.toLowerCase() === t.toLowerCase());
      if (same) return same;
      if (notes.length >= MAX_NOTES) throw new MemoryError(`Memory is full (${MAX_NOTES} notes). Forget some in Ask Fetch → Memory first.`);
      const note = { id: crypto.randomBytes(4).toString('hex'), text: t, at: new Date(now()).toISOString() };
      await writeJson(notesFile, { notes: [...notes, note] });
      return note;
    },
    async forget(id) {
      const notes = await loadNotes();
      const gone = notes.find((n) => n.id === id);
      if (!gone) throw new MemoryError(`No note with id "${id}".`);
      await writeJson(notesFile, { notes: notes.filter((n) => n.id !== id) });
      return gone;
    },
    async forgetAll() { await writeJson(notesFile, { notes: [] }); },

    /** Saved conversations: { id → { messages, log, system, model, at } }, newest kept. */
    async loadSessions() {
      const d = await readJson(historyFile, { sessions: {} });
      const cutoff = now() - KEEP_DAYS * 86_400_000;
      return Object.entries(d.sessions ?? {}).filter(([, s]) => s && s.at > cutoff && Array.isArray(s.messages));
    },
    async saveSessions(entries) {
      const keep = entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEPT);
      await writeJson(historyFile, { sessions: Object.fromEntries(keep) });
    },
    async clearSessions() { await writeJson(historyFile, { sessions: {} }); },
  };
}
