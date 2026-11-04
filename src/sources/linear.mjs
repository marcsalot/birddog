// Linear source: open issues assigned to you, ranked like other tickets (due date,
// cycle end, blocked, priority). A personal API key from Linear's settings, kept in
// your keychain. Read-only: GraphQL queries only, never mutations.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { daysSince, daysUntilDate, jsonClient, tokenSetup } from './web.mjs';

export const id = 'linear';
export const name = 'Linear';
export const description = 'Issues assigned to you, ranked by due date, cycle end, blockers and priority.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'linear-token' });
export const setup = tokenSetup({
  fields: [],
  token: { label: 'Personal API key', help: 'https://linear.app/settings/account/security', placeholder: 'lin_api_…' },
  notes: 'Linear → Settings → Security & access → Personal API keys. Read access is enough.',
});

export function normalizeSettings() { return {}; }

const URL_ = 'https://api.linear.app/graphql';
const FIELDS = 'id identifier title url priorityLabel dueDate updatedAt state { name type } cycle { name number endsAt }';
const QUERY = `query Birddog { viewer { name email assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${FIELDS} inverseRelations { nodes { type issue { identifier state { type } } } } } } } }`;
const QUERY_SIMPLE = `query Birddog { viewer { name email assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${FIELDS} } } } }`;

async function run(ctx, query) {
  const key = await ctx.secret?.(secretFields.token);
  if (!key) throw new Error('Add a Linear personal API key in setup.');
  const http = jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Linear', headers: { authorization: key }, fix: 'Make a new personal API key in Linear and update it in setup.' });
  const r = await http.query(URL_, { query });
  if (r?.errors?.length) throw Object.assign(new Error(`Linear: ${r.errors[0].message}`), { graphql: true });
  return r?.data;
}

export function linearSignal(issue, now) {
  const blockers = (issue.inverseRelations?.nodes ?? []).filter((x) => x.type === 'blocks' && !['completed', 'canceled'].includes(x.issue?.state?.type)).map((x) => x.issue.identifier);
  return {
    status: issue.state?.name ?? 'Open',
    priority: issue.priorityLabel && issue.priorityLabel !== 'No priority' ? issue.priorityLabel : null,
    dueDays: daysUntilDate(issue.dueDate, now),
    sprint: issue.cycle ? (issue.cycle.name || `Cycle ${issue.cycle.number}`) : null,
    sprintDays: issue.cycle?.endsAt ? (Date.parse(issue.cycle.endsAt) - now) / 86_400_000 : null,
    blockedBy: blockers,
    flagged: false,
    blockedStatus: /\b(blocked|on hold)\b/i.test(issue.state?.name ?? ''),
    ageDays: daysSince(now, issue.updatedAt),
  };
}

export async function test(config = {}, ctx = {}) {
  try {
    const d = await run(ctx, 'query { viewer { name email } }');
    return { ok: true, message: `Connected to Linear as ${d.viewer.name ?? d.viewer.email}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  let data;
  try { data = await run(ctx, QUERY); } catch (err) {
    if (!err.graphql) throw err;
    (ctx.warn ?? (() => {}))('Linear: blockers are skipped (the relations query was refused)');
    data = await run(ctx, QUERY_SIMPLE);
  }
  const issues = data?.viewer?.assignedIssues?.nodes ?? [];
  const items = issues.map((i) => {
    const s = linearSignal(i, now);
    const r = rank('ticket', s);
    return createItem({
      id: `linear:${i.identifier}`, source: id, kind: 'ticket', title: `${i.identifier} · ${i.title}`, url: i.url,
      why: r.why, urgency: r.urgency, updatedAt: i.updatedAt,
      meta: { rule: r.rule, fingerprint: [s.status, s.priority, i.dueDate, s.sprint, s.blockedBy.join(',')].join('|'), fields: { Issue: i.identifier, Status: s.status, Priority: s.priority ?? 'none', Due: i.dueDate ?? 'no due date', Cycle: s.sprint ?? 'none', 'Blocked by': s.blockedBy.join(', ') || 'nothing' } },
    });
  });
  ctx.summary?.(`${data?.viewer?.name ?? 'Linear'} · ${plural(items.length, 'open issue')}`);
  return items;
}
