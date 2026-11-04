// PagerDuty source: open incidents assigned to you, and when you are on call.
// A personal user API token (User Settings → API Access), kept in your keychain.
// Read-only (GET only). Acknowledge and resolve stay in PagerDuty.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { baseUrl, daysSince, jsonClient, tokenSetup } from './web.mjs';

export const id = 'pagerduty';
export const name = 'PagerDuty';
export const description = 'Incidents assigned to you, and your on-call shifts.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'pagerduty-token' });
export const setup = tokenSetup({
  fields: [{ key: 'url', label: 'API address', placeholder: 'https://api.pagerduty.com (EU: https://api.eu.pagerduty.com)', optional: true }],
  token: { label: 'User API token (read-only is enough)', help: 'https://support.pagerduty.com/main/docs/api-access-keys#generate-a-user-token-rest-api-key', placeholder: 'Paste your user token' },
  oauth: 'pagerduty',
});

export function normalizeSettings(input = {}) { return { url: baseUrl(input.url, 'https://api.pagerduty.com'), auth: input.auth === 'oauth' ? 'oauth' : 'token' }; }

async function client(config, ctx) {
  let authorization;
  if (config.auth === 'oauth') {
    if (!ctx.oauth) throw new Error('Sign in to PagerDuty in setup.');
    authorization = `Bearer ${await ctx.oauth.accessToken('pagerduty')}`;
  } else {
    const token = await ctx.secret?.(secretFields.token);
    if (!token) throw new Error('Add a PagerDuty user API token in setup, or sign in with PagerDuty.');
    authorization = `Token token=${token}`;
  }
  const base = baseUrl(config.url, 'https://api.pagerduty.com');
  return { base, http: jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'PagerDuty', headers: { authorization, accept: 'application/vnd.pagerduty+json;version=2' }, fix: config.auth === 'oauth' ? 'Sign in to PagerDuty again in setup.' : 'Make a new user API token in PagerDuty and update it in setup.' }) };
}

const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export async function test(config = {}, ctx = {}) {
  try {
    const { base, http } = await client(config, ctx);
    const me = await http.get(`${base}/users/me`);
    return { ok: true, message: `Connected to PagerDuty as ${me?.user?.name ?? me?.user?.email ?? 'you'}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const { base, http } = await client(config, ctx);
  const me = (await http.get(`${base}/users/me`))?.user;
  if (!me?.id) throw new Error('PagerDuty did not say whose token this is (use a user token, not an account key).');
  const items = [];
  const inc = new URLSearchParams([['statuses[]', 'triggered'], ['statuses[]', 'acknowledged'], ['user_ids[]', me.id], ['limit', '50']]);
  const incidents = (await http.get(`${base}/incidents?${inc}`))?.incidents ?? [];
  for (const i of incidents) {
    const s = { status: i.status, urgencyLevel: i.urgency, service: i.service?.summary ?? null, ageDays: daysSince(now, i.created_at) };
    const r = rank('incident', s);
    items.push(createItem({
      id: `pagerduty:incident:${i.id}`, source: id, kind: 'incident', title: `#${i.incident_number ?? i.id} · ${i.title ?? i.summary ?? 'Incident'}`, url: /^https?:\/\//.test(i.html_url ?? '') ? i.html_url : null,
      why: r.why, urgency: r.urgency, updatedAt: i.created_at,
      meta: { rule: r.rule, fingerprint: i.status, fields: { Incident: `#${i.incident_number ?? i.id}`, Status: i.status, Urgency: i.urgency ?? '', Service: s.service ?? '' } },
    }));
  }
  const oc = new URLSearchParams([['user_ids[]', me.id], ['since', new Date(now).toISOString()], ['until', new Date(now + 86_400_000).toISOString()]]);
  const shifts = (await http.get(`${base}/oncalls?${oc}`))?.oncalls ?? [];
  const seen = new Set();
  for (const o of shifts) {
    const policy = o.escalation_policy?.summary ?? o.schedule?.summary ?? null;
    const start = o.start ? Date.parse(o.start) : now;
    const end = o.end ? Date.parse(o.end) : null;
    const key = `${policy}|${start}`;
    if (seen.has(key) || (end && end <= now)) continue;
    seen.add(key);
    const s = { policy, startsIn: start - now, startLabel: when(start), endLabel: end ? when(end) : 'further notice' };
    const r = rank('on-call', s);
    items.push(createItem({
      id: `pagerduty:oncall:${o.escalation_policy?.id ?? policy}:${o.schedule?.id ?? 'direct'}`, source: id, kind: 'on-call',
      title: `On call${policy ? ` · ${policy}` : ''}`, url: /^https?:\/\//.test(o.schedule?.html_url ?? o.escalation_policy?.html_url ?? '') ? (o.schedule?.html_url ?? o.escalation_policy.html_url) : null,
      why: r.why, urgency: r.urgency, updatedAt: new Date(start).toISOString(),
      meta: { rule: r.rule, fingerprint: `${start}|${end}`, fields: { Policy: policy ?? '', Schedule: o.schedule?.summary ?? 'direct', From: when(start), Until: end ? when(end) : 'further notice', Level: String(o.escalation_level ?? '') } },
    }));
  }
  ctx.summary?.(`${me.name ?? me.email ?? 'you'} · ${plural(incidents.length, 'open incident')}${items.some((i) => i.kind === 'on-call' && i.urgency === 'today') ? ' · on call now' : ''}`);
  return items;
}
