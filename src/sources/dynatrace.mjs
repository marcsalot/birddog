// Dynatrace: open problems (Davis AI incidents) in your environment, critical ones first.
// An API token with the problems.read scope, kept in your keychain. SaaS
// (https://abc12345.live.dynatrace.com) or Managed (https://host/e/<environment-id>),
// which can be on your own network. Read-only: GET only.
//
// Dynatrace problems aren't assigned to people, so narrow them down with a management
// zone or an entity selector, or you'll see every open problem in the environment.

import { plural, rank } from '../rules.mjs';
import { createItem } from '../items.mjs';
import { daysSince, jsonClient, selfHostedUrl, tokenSetup } from './web.mjs';

export const id = 'dynatrace';
export const name = 'Dynatrace';
export const description = 'Open problems in your environment: availability and error problems first.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'dynatrace-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'url', label: 'Environment address', placeholder: 'https://abc12345.live.dynatrace.com or https://host/e/<id>' },
    { key: 'zone', label: 'Management zone', placeholder: 'only problems in this zone', optional: true },
    { key: 'entities', label: 'Entity selector', placeholder: 'e.g. type("SERVICE"),tag("team:payments")', optional: true },
  ],
  token: { label: 'API token (scope: problems.read)', help: 'https://docs.dynatrace.com/docs/manage/identity-access-management/access-tokens-and-oauth-clients/access-tokens', placeholder: 'dt0c01.…' },
  notes: 'Dynatrace → Access tokens → Generate new token → scope "Read problems" (problems.read). Problems aren\'t assigned to people, so pick a management zone or entity selector to see just yours.',
});

/** Problems that are outages or errors are critical; slowdowns and resource problems aren't. */
export const CRITICAL = new Set(['AVAILABILITY', 'ERROR']);
const SEVERITY = { AVAILABILITY: 'availability', ERROR: 'error', PERFORMANCE: 'slowdown', RESOURCE_CONTENTION: 'resources', CUSTOM_ALERT: 'custom alert', MONITORING_UNAVAILABLE: 'monitoring unavailable', INFO: 'info' };

export function normalizeSettings(input = {}) {
  const url = selfHostedUrl(input.url, 'Dynatrace environment');
  const zone = String(input.zone ?? '').trim().slice(0, 200);
  const entities = String(input.entities ?? '').trim().slice(0, 500);
  return { url: url.replace(/\/api(\/v2)?$/, ''), zone, entities };
}

async function client(config, ctx) {
  if (!config.url) throw new Error('Add your Dynatrace environment address in setup.');
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add a Dynatrace API token (problems.read) in setup.');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: new URL(config.url).host, headers: { authorization: `Api-Token ${token.replace(/^Api-Token\s+/i, '')}` }, fix: 'Make a token with problems.read and update it in setup.' });
}

/** The problemSelector for open problems, narrowed by zone. Quotes in names are escaped. */
export function problemSelector(config = {}) {
  const parts = ['status("OPEN")'];
  if (config.zone) parts.push(`managementZones("${config.zone.replace(/[~"]/g, (c) => `~${c}`)}")`);
  return parts.join(',');
}

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(config, ctx);
    const r = await http.get(`${config.url}/api/v2/problems?${new URLSearchParams({ problemSelector: problemSelector(config), pageSize: '1' })}`);
    return { ok: true, message: `Connected to Dynatrace · ${plural(r?.totalCount ?? 0, 'open problem')}${config.zone ? ` in ${config.zone}` : ''}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(config, ctx);
  const q = new URLSearchParams({ problemSelector: problemSelector(config), pageSize: '100' }); // affected entities come by default
  if (config.entities) q.set('entitySelector', config.entities);
  const r = await http.get(`${config.url}/api/v2/problems?${q}`);
  const items = (r?.problems ?? []).filter((p) => p.status === 'OPEN').map((p) => {
    const startedAt = Number(p.startTime) > 0 ? new Date(Number(p.startTime)).toISOString() : new Date(now).toISOString();
    const affected = (p.affectedEntities ?? []).map((e) => e.name).filter(Boolean);
    const s = { critical: CRITICAL.has(p.severityLevel), severity: SEVERITY[p.severityLevel] ?? String(p.severityLevel ?? 'problem').toLowerCase(), ageDays: daysSince(now, startedAt), what: affected.slice(0, 2).join(', ') + (affected.length > 2 ? ` +${affected.length - 2}` : '') };
    const rk = rank('alert', s);
    return createItem({
      id: `dynatrace:${p.problemId}`, source: id, kind: 'alert', title: `${p.displayId ?? 'Problem'} · ${p.title ?? 'Problem'}`,
      url: `${config.url}/#problems/problemdetails;pid=${encodeURIComponent(p.problemId)}`, why: rk.why, urgency: rk.urgency, updatedAt: startedAt,
      meta: { rule: rk.rule, fingerprint: [p.severityLevel, p.impactLevel, affected.length].join('|'), fields: { Problem: p.displayId ?? p.problemId, Severity: s.severity, Impact: String(p.impactLevel ?? '').toLowerCase() || 'unknown', Affected: affected.join(', ') || 'unknown', Zones: (p.managementZones ?? []).map((z) => z.name).join(', ') || 'none' } },
    });
  });
  ctx.summary?.(`${plural(items.length, 'open problem')}${config.zone ? ` in ${config.zone}` : ''}`);
  return items;
}
