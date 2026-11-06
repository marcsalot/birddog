// Grafana: alerts that are firing right now (Grafana Alerting), critical ones first.
// Works with Grafana Cloud and with a private, self-hosted Grafana: Birddog runs on your
// computer, so it reaches anything your computer can (your office network or VPN).
// Plain http is accepted only for hosts on your own network.
//
// A service account token with the Viewer role, kept in your keychain. Reads the
// Alertmanager-compatible API (active, not silenced, not inhibited). Read-only: GET only.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { daysSince, jsonClient, selfHostedUrl, tokenSetup } from './web.mjs';

export const id = 'grafana';
export const name = 'Grafana';
export const description = 'Alerts firing now, critical first. Grafana Cloud or your own (private) Grafana.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'grafana-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'url', label: 'Grafana address', placeholder: 'https://grafana.internal.acme.com or https://acme.grafana.net' },
    { key: 'filter', label: 'Only alerts with these labels', placeholder: 'team=payments, env=prod', optional: true },
  ],
  token: { label: 'Service account token (Viewer role)', help: 'https://grafana.com/docs/grafana/latest/administration/service-accounts/', placeholder: 'glsa_…' },
  notes: 'Grafana → Administration → Service accounts → Add (role Viewer) → Add token. A private Grafana works while your computer can reach it (office network or VPN). Certificates from your company\'s own CA: start Birddog with NODE_EXTRA_CA_CERTS.',
});

const CRITICAL = /^(critical|crit|page|pager|p1|sev1|sev-1|emergency|disaster)$/i;
const MATCHER = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"?([^",]*)"?\s*$/;

/** "team=payments, env!=dev" → ['team="payments"', 'env!="dev"'] (Alertmanager matchers). */
export function parseFilter(text) {
  const out = [];
  for (const part of String(text ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = MATCHER.exec(part);
    if (!m) throw new TypeError(`"${part}" isn't a label filter. Use label=value (or !=, =~, !~), separated by commas`);
    out.push(`${m[1]}${m[2]}"${m[3].replace(/"/g, '')}"`);
  }
  return out;
}

export function normalizeSettings(input = {}) {
  const url = selfHostedUrl(input.url, 'Grafana');
  const filter = String(input.filter ?? '').trim().slice(0, 500);
  parseFilter(filter);
  return { url, filter };
}

async function client(config, ctx) {
  if (!config.url) throw new Error('Add your Grafana address in setup.');
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add a Grafana service account token in setup.');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: new URL(config.url).host, headers: { authorization: `Bearer ${token}` }, fix: 'Make a new service account token (Viewer) and update it in setup.' });
}

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(config, ctx);
    const alerts = await http.get(alertsUrl(config));
    return { ok: true, message: `Connected to Grafana at ${new URL(config.url).host} · ${plural(alerts?.length ?? 0, 'alert')} firing` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export function alertsUrl(config) {
  const q = new URLSearchParams({ active: 'true', silenced: 'false', inhibited: 'false' });
  for (const f of parseFilter(config.filter)) q.append('filter', f);
  return `${config.url}/api/alertmanager/grafana/api/v2/alerts?${q}`;
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(config, ctx);
  const alerts = (await http.get(alertsUrl(config))) ?? [];
  const items = alerts.filter((a) => (a.status?.state ?? 'active') === 'active').map((a) => {
    const l = a.labels ?? {};
    const sev = l.severity ?? l.priority ?? l.level ?? 'firing';
    const what = [l.service, l.job, l.namespace, l.instance].find(Boolean) ?? l.grafana_folder ?? null;
    const s = { critical: CRITICAL.test(sev), severity: sev, ageDays: daysSince(now, a.startsAt), what };
    const rk = rank('alert', s);
    const summary = a.annotations?.summary ?? a.annotations?.description ?? '';
    const link = [a.generatorURL, a.annotations?.runbook_url].find((u) => /^https?:\/\//.test(u ?? '')) ?? `${config.url}/alerting/list`;
    return createItem({
      id: `grafana:${a.fingerprint ?? `${l.alertname}:${a.startsAt}`}`, source: id, kind: 'alert',
      title: `${l.alertname ?? 'Alert'}${summary ? ` · ${String(summary).replace(/\s+/g, ' ').slice(0, 110)}` : ''}`,
      url: link, why: rk.why, urgency: rk.urgency, updatedAt: a.startsAt ?? new Date(now).toISOString(),
      meta: {
        rule: rk.rule, fingerprint: [sev, a.startsAt].join('|'),
        fields: { Alert: l.alertname ?? 'unknown', Severity: sev, Since: a.startsAt ?? 'unknown', ...(what ? { Where: what } : {}), ...(a.annotations?.runbook_url ? { Runbook: a.annotations.runbook_url } : {}) },
      },
    });
  });
  ctx.summary?.(`${new URL(config.url).host} · ${plural(items.length, 'alert')} firing`);
  return items;
}
