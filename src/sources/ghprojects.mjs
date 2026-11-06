// GitHub Projects: items assigned to you on the project boards you list, that aren't
// done yet. Ranked like tickets: iteration ending, due date (a "Due", "Target" or
// "Deadline" date field), priority (a "Priority" field), and a blocked status.
//
// Uses your GitHub sign-in (the GitHub source's), which needs the read:project scope:
// Birddog's own sign-in asks for it; a gh CLI token gets it with
// `gh auth refresh -s read:project`. Read-only: GraphQL queries, never mutations.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { daysSince, daysUntilDate, jsonClient } from './web.mjs';

export const id = 'ghprojects';
export const name = 'GitHub Projects';
export const description = 'Project items assigned to you that aren\'t done, ranked by iteration end, due date and priority.';
export const enabledByDefault = false;
export const setup = {
  fields: [{ key: 'projects', label: 'Project boards (one per line or comma-separated)', placeholder: 'https://github.com/orgs/acme/projects/5' }],
  token: null,
  how: 'using your GitHub sign-in',
  notes: 'Uses your GitHub sign-in. It needs the read:project scope: Birddog\'s own GitHub sign-in asks for it; with the gh CLI, run "gh auth refresh -s read:project".',
};

const PROJECT_URL = /^https:\/\/([^/]+)\/(orgs|users)\/([A-Za-z0-9-]+)\/projects\/(\d+)\/?(?:views\/\d+)?\/?$/;
const DONE = /^(done|closed|complete|completed|shipped|released|merged|won't do|wont do|cancel+ed)$/i;
const BLOCKED = /\b(blocked|on hold|waiting)\b/i;
const MAX_PAGES = 5;

/** "https://github.com/orgs/acme/projects/5" → { host, owner, number, url }. */
export function parseProject(url) {
  const m = PROJECT_URL.exec(String(url).trim());
  if (!m) return null;
  return { host: m[1].toLowerCase(), kind: m[2], owner: m[3], number: Number(m[4]), url: `https://${m[1]}/${m[2]}/${m[3]}/projects/${m[4]}` };
}

export function normalizeSettings(input = {}) {
  const raw = Array.isArray(input.projects) ? input.projects : String(input.projects ?? '').split(/[\s,]+/);
  const list = raw.map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) throw new TypeError('Add at least one project board link, like https://github.com/orgs/acme/projects/5');
  const bad = list.find((x) => !parseProject(x));
  if (bad) throw new TypeError(`"${bad}" isn't a project board link. Copy it from the project's page: https://github.com/orgs/ORG/projects/N or /users/NAME/projects/N`);
  return { projects: list.map((x) => parseProject(x).url).join('\n') };
}

const FIELD = '... on ProjectV2FieldCommon { name }';
const PEOPLE = 'assignees(first: 10) { nodes { login } }';
export const QUERY = `query Birddog($login: String!, $number: Int!, $cursor: String) {
  viewer { login }
  owner: repositoryOwner(login: $login) {
    ... on Organization { projectV2(number: $number) { ...P } }
    ... on User { projectV2(number: $number) { ...P } }
  }
}
fragment P on ProjectV2 {
  title url closed
  items(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id isArchived updatedAt
      fieldValues(first: 30) { nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ${FIELD} } }
        ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ${FIELD} } }
        ... on ProjectV2ItemFieldDateValue { date field { ${FIELD} } }
      } }
      content {
        __typename
        ... on Issue { title url number state ${PEOPLE} repository { nameWithOwner } }
        ... on PullRequest { title url number state ${PEOPLE} repository { nameWithOwner } }
        ... on DraftIssue { title ${PEOPLE} }
      }
    }
  }
}`;

const graphqlUrl = (host) => (host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`);

async function token(ctx) {
  if (!ctx.github) throw new Error('Sign in to GitHub in setup first (GitHub Projects uses that sign-in).');
  const t = await ctx.github.token().catch((e) => { throw new Error(`${e.message} Or sign in to GitHub again in setup.`); });
  if (!t) throw new Error('Sign in to GitHub in setup first (GitHub Projects uses that sign-in).');
  return t;
}

async function fetchProject(p, ctx, tok) {
  const http = jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: p.host, headers: { authorization: `Bearer ${tok}` }, fix: 'Sign in to GitHub again in setup.' });
  const nodes = [];
  let project = null;
  let viewer = null;
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await http.query(graphqlUrl(p.host), { query: QUERY, variables: { login: p.owner, number: p.number, cursor } });
    if (r?.errors?.length) {
      const e = r.errors[0];
      if (e.type === 'INSUFFICIENT_SCOPES' || /read:project/.test(e.message ?? '')) throw new Error('Your GitHub sign-in can\'t read Projects: it needs the read:project scope. Run "gh auth refresh -s read:project", or sign in to GitHub again in setup.');
      if (e.type === 'NOT_FOUND' && !r.data?.owner?.projectV2) throw new Error(`${p.url}: no such project, or you can't see it`);
    }
    viewer = r?.data?.viewer?.login ?? viewer;
    project = r?.data?.owner?.projectV2 ?? project;
    if (!project) throw new Error(`${p.url}: no such project, or you can't see it`);
    const items = r.data.owner.projectV2.items;
    nodes.push(...(items?.nodes ?? []));
    if (!items?.pageInfo?.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }
  return { project, viewer, nodes };
}

/** One project item → the ticket signal (or null when it's not yours or it's done). */
export function itemSignal(node, me, now) {
  const c = node.content;
  if (!c || node.isArchived) return null;
  if (c.state && c.state !== 'OPEN') return null;
  if (!(c.assignees?.nodes ?? []).some((a) => a.login?.toLowerCase() === String(me).toLowerCase())) return null;
  const values = node.fieldValues?.nodes ?? [];
  const named = (re) => values.find((v) => re.test(v?.field?.name ?? ''));
  const status = named(/^status$/i)?.name ?? null;
  if (status && DONE.test(status)) return null;
  const iteration = values.find((v) => v && 'startDate' in v && v.startDate);
  const due = named(/due|target|deadline/i)?.date ?? null;
  const priority = named(/priority/i)?.name ?? null;
  const iterEnd = iteration ? Date.parse(`${iteration.startDate}T00:00:00`) + Number(iteration.duration ?? 0) * 86_400_000 : null;
  return {
    status: status ?? 'No status',
    priority: priority && !/^(none|no priority)$/i.test(priority) ? priority : null,
    dueDays: daysUntilDate(due, now),
    sprint: iteration?.title ?? null,
    sprintDays: iterEnd ? (iterEnd - now) / 86_400_000 : null,
    blockedBy: [],
    flagged: false,
    blockedStatus: BLOCKED.test(status ?? ''),
    ageDays: daysSince(now, node.updatedAt),
    due,
  };
}

export async function test(config = {}, ctx = {}) {
  try {
    const list = String(config.projects ?? '').split('\n').filter(Boolean).map(parseProject).filter(Boolean);
    if (!list.length) throw new Error('Add a project board link in setup.');
    const tok = await token(ctx);
    const names = [];
    for (const p of list) names.push((await fetchProject(p, ctx, tok)).project.title);
    return { ok: true, message: `Reading ${names.join(', ')}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const list = String(config.projects ?? '').split('\n').filter(Boolean).map(parseProject).filter(Boolean);
  if (!list.length) throw new Error('Add a project board link in setup.');
  const tok = await token(ctx);
  const items = [];
  for (const p of list) {
    let got;
    try { got = await fetchProject(p, ctx, tok); } catch (e) { if (list.length === 1) throw e; ctx.warn?.(e.message); continue; }
    for (const node of got.nodes) {
      const s = itemSignal(node, got.viewer, now);
      if (!s) continue;
      const r = rank('ticket', s);
      const c = node.content;
      const ref = c.repository ? `${c.repository.nameWithOwner.split('/')[1]}#${c.number}` : 'Draft';
      items.push(createItem({
        id: `ghprojects:${p.owner}/${p.number}:${node.id}`, source: id, kind: 'ticket', title: `${ref} · ${c.title}`,
        url: /^https:\/\//.test(c.url ?? '') ? c.url : got.project.url, why: r.why, urgency: r.urgency, updatedAt: node.updatedAt,
        meta: { rule: r.rule, fingerprint: [s.status, s.priority, s.due, s.sprint].join('|'), fields: { Project: got.project.title, Status: s.status, Priority: s.priority ?? 'none', Iteration: s.sprint ?? 'none', Due: s.due ?? 'no due date' } },
      }));
    }
  }
  ctx.summary?.(`${plural(list.length, 'project')} · ${plural(items.length, 'item')} assigned to you`);
  return items;
}
