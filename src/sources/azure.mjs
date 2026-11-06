// Azure DevOps source (Boards and Repos), built from Microsoft's public REST docs.
//
//   • pull requests where you are a reviewer and haven't voted yet
//   • open work items assigned to you, ranked like other tickets
//
// "Sign in with Azure DevOps" (the "azuredevops" sign-in on Birddog's Microsoft app, with
// the read-only Azure DevOps scopes vso.code and vso.work), or a personal access token with
// "Work Items: Read" and "Code: Read" kept in your keychain. Read-only: GET, plus WIQL
// queries (which Azure only accepts as POST).

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { daysSince, daysUntilDate, jsonClient, tokenSetup } from './web.mjs';

export const id = 'azure';
export const name = 'Azure DevOps';
export const description = 'Pull requests waiting for your review and work items assigned to you.';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'azure-devops-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'organization', label: 'Organization', placeholder: 'contoso (from dev.azure.com/contoso)' },
    { key: 'project', label: 'Project', placeholder: 'Payments' },
  ],
  token: { label: 'Personal access token (Work Items: Read, Code: Read)', help: 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate', placeholder: 'Paste your PAT' },
  notes: 'Sign in with your work account, or use a personal access token. Either way, enter the organization and project.',
  oauth: 'azuredevops',
});

const API = '7.1';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export function normalizeSettings(input = {}) {
  let org = String(input.organization ?? '').trim().replace(/^https?:\/\/dev\.azure\.com\//i, '').replace(/^https?:\/\/([^.]+)\.visualstudio\.com.*$/i, '$1').replace(/\/.*$/, '');
  const project = String(input.project ?? '').trim();
  if (!SLUG.test(org)) throw new TypeError('Enter your Azure DevOps organization, like contoso');
  if (!SLUG.test(project)) throw new TypeError('Enter the project name');
  org = org.toLowerCase();
  // auth is set by the sign-in (oauth) or by saving a token; a form without it keeps what's saved.
  const auth = input.auth === 'oauth' || input.auth === 'token' ? { auth: input.auth } : {};
  return { organization: org, project, ...auth };
}

async function client(config, ctx) {
  if (!config.organization || !config.project) throw new Error('Add your Azure DevOps organization and project in setup.');
  let authorization;
  if (config.auth === 'oauth') {
    if (!ctx.oauth) throw new Error('Sign in with Azure DevOps in setup.');
    authorization = `Bearer ${await ctx.oauth.accessToken('azuredevops')}`;
  } else {
    const pat = await ctx.secret?.(secretFields.token);
    if (!pat) throw new Error('Sign in with Azure DevOps, or add a personal access token, in setup.');
    authorization = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }
  const http = jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: 'Azure DevOps', headers: { authorization }, fix: config.auth === 'oauth' ? 'Sign in with Azure DevOps again in setup (your organization may also need to allow Microsoft Entra apps).' : 'Check the token\'s scopes (Work Items: Read, Code: Read) and expiry in setup.' });
  const org = `https://dev.azure.com/${encodeURIComponent(config.organization)}`;
  const proj = `${org}/${encodeURIComponent(config.project)}`;
  return { http, org, proj };
}

const PRIORITY = { 1: 'Highest', 2: 'High', 3: 'Medium', 4: 'Low' };

export async function test(config = {}, ctx = {}) {
  try {
    const { http, org } = await client(config, ctx);
    const me = await http.get(`${org}/_apis/connectionData`);
    return { ok: true, message: `Connected to ${config.organization}/${config.project} as ${me?.authenticatedUser?.providerDisplayName ?? 'you'}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const { http, org, proj } = await client(config, ctx);
  const me = await http.get(`${org}/_apis/connectionData`);
  const myId = me?.authenticatedUser?.id;
  if (!myId) throw new Error('Azure DevOps did not say who this token belongs to.');
  const items = [];

  const prs = (await http.get(`${proj}/_apis/git/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(myId)}&searchCriteria.status=active&api-version=${API}`))?.value ?? [];
  for (const pr of prs) {
    const mine = (pr.reviewers ?? []).find((r) => r.id === myId);
    if (mine && mine.vote) continue; // you already voted
    const repo = pr.repository?.name ?? 'repo';
    const url = pr.repository?.webUrl ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}` : `${proj}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`;
    const signal = { requester: pr.createdBy?.uniqueName?.split('@')[0] ?? pr.createdBy?.displayName ?? null, team: mine ? null : 'a group you are in', draft: !!pr.isDraft, ageDays: daysSince(now, pr.creationDate) };
    const r = rank('review-request', signal);
    items.push(createItem({
      id: `azure:pr:${repo}!${pr.pullRequestId}`, source: id, kind: 'review-request', title: `${repo}!${pr.pullRequestId} · ${pr.title}`, url,
      why: r.why, urgency: r.urgency, updatedAt: pr.creationDate,
      meta: { rule: r.rule, fingerprint: String(pr.lastMergeSourceCommit?.commitId ?? pr.pullRequestId), fields: { Repo: repo, 'Pull request': `!${pr.pullRequestId}`, Author: pr.createdBy?.displayName ?? 'unknown', Draft: pr.isDraft ? 'yes' : 'no' } },
    }));
  }

  const wiql = await http.query(`${proj}/_apis/wit/wiql?api-version=${API}`, {
    query: "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed') ORDER BY [System.ChangedDate] DESC",
  });
  const ids = (wiql?.workItems ?? []).slice(0, 100).map((w) => w.id);
  if (ids.length) {
    const fields = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.ChangedDate', 'System.Tags', 'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Scheduling.DueDate'];
    const list = (await http.get(`${proj}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields.join(',')}&api-version=${API}`))?.value ?? [];
    for (const w of list) {
      const f = w.fields ?? {};
      const tags = String(f['System.Tags'] ?? '').split(';').map((t) => t.trim()).filter(Boolean);
      const s = {
        status: f['System.State'] ?? 'Open',
        priority: PRIORITY[f['Microsoft.VSTS.Common.Priority']] ?? null,
        dueDays: daysUntilDate(f['Microsoft.VSTS.Scheduling.DueDate'], now),
        sprint: null, sprintDays: null,
        blockedBy: [],
        flagged: tags.some((t) => /^blocked$/i.test(t)),
        blockedStatus: /\bblocked\b/i.test(f['System.State'] ?? ''),
        ageDays: daysSince(now, f['System.ChangedDate'] ?? new Date(now).toISOString()),
      };
      const r = rank('ticket', s);
      items.push(createItem({
        id: `azure:wi:${w.id}`, source: id, kind: 'ticket', title: `${f['System.WorkItemType'] ?? 'Item'} ${w.id} · ${f['System.Title'] ?? ''}`.trim(),
        url: `${proj}/_workitems/edit/${w.id}`, why: r.why, urgency: r.urgency, updatedAt: f['System.ChangedDate'] ?? new Date(now).toISOString(),
        meta: { rule: r.rule, fingerprint: [s.status, s.priority, f['Microsoft.VSTS.Scheduling.DueDate'], tags.join(',')].join('|'), fields: { 'Work item': String(w.id), Type: f['System.WorkItemType'] ?? '', Status: s.status, Priority: s.priority ?? 'none', Iteration: f['System.IterationPath'] ?? '', Tags: tags.join(', ') || 'none' } },
      }));
    }
  }
  ctx.summary?.(`${config.organization}/${config.project} · ${plural(prs.length, 'review')} · ${plural(ids.length, 'work item')}`);
  return items;
}
