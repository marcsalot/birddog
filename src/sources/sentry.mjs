// Sentry source: unresolved issues assigned to you, with new and regressed ones first.
// An auth token with the event:read scope (and org:read), kept in your keychain.
// sentry.io, the EU region (de.sentry.io) or self-hosted. Read-only (GET only).

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { baseUrl, daysSince, jsonClient, tokenSetup } from './web.mjs';

export const id = 'sentry';
export const name = 'Sentry';
export const description = 'New and regressed errors assigned to you.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'sentry-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'organization', label: 'Organization slug', placeholder: 'acme (from acme.sentry.io)' },
    { key: 'url', label: 'Sentry address', placeholder: 'https://sentry.io', optional: true },
  ],
  token: { label: 'Auth token (scopes: event:read, org:read)', help: 'https://sentry.io/settings/account/api/auth-tokens/', placeholder: 'sntryu_…' },
});

export function normalizeSettings(input = {}) {
  const org = String(input.organization ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(org)) throw new TypeError('Enter your Sentry organization slug, like acme');
  return { organization: org, url: baseUrl(input.url, 'https://sentry.io') };
}

async function client(config, ctx) {
  if (!config.organization) throw new Error('Add your Sentry organization and an auth token in setup.');
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add a Sentry auth token in setup.');
  const base = baseUrl(config.url, 'https://sentry.io');
  return { base, http: jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: new URL(base).host, headers: { authorization: `Bearer ${token}` }, fix: 'Make a token with event:read and org:read and update it in setup.' }) };
}

export async function test(config = {}, ctx = {}) {
  try {
    const { base, http } = await client(config, ctx);
    const org = await http.get(`${base}/api/0/organizations/${encodeURIComponent(config.organization)}/`);
    return { ok: true, message: `Connected to Sentry organization ${org?.name ?? config.organization}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const { base, http } = await client(config, ctx);
  const q = new URLSearchParams({ query: 'is:unresolved assigned:me', statsPeriod: '14d', limit: '50' });
  const issues = await http.get(`${base}/api/0/organizations/${encodeURIComponent(config.organization)}/issues/?${q}`) ?? [];
  const items = issues.map((i) => {
    const s = {
      regressed: ['regressed', 'escalating'].includes(i.substatus) || i.isRegression === true,
      newDays: daysSince(now, i.firstSeen),
      count: Number(i.count) || 0,
      users: Number(i.userCount) || 0,
      lastSeenDays: daysSince(now, i.lastSeen),
    };
    const r = rank('error-issue', s);
    return createItem({
      id: `sentry:${i.id}`, source: id, kind: 'error-issue', title: `${i.shortId ?? i.id} · ${i.title}`, url: /^https?:\/\//.test(i.permalink ?? '') ? i.permalink : null,
      why: r.why, urgency: r.urgency, updatedAt: i.lastSeen,
      meta: { rule: r.rule, fingerprint: [i.substatus, i.status].join('|'), fields: { Issue: i.shortId ?? i.id, Project: i.project?.slug ?? '', Where: i.culprit ?? '', Level: i.level ?? '', Events: String(s.count), Users: String(s.users), 'First seen': i.firstSeen?.slice(0, 10) ?? '' } },
    });
  });
  ctx.summary?.(`${config.organization} · ${plural(items.length, 'unresolved issue')} assigned to you`);
  return items;
}
