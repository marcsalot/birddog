// Jenkins: jobs whose last finished build failed or is unstable, in the view or folder
// you choose (multibranch pipelines included, one branch per item). "Only mine" keeps the
// builds you started or that list you among the culprits.
//
// Your username and an API token (Jenkins → your name → Security → API Token), kept in your
// keychain. Works with a Jenkins on your own network: plain http is accepted only there.
// Read-only: GET /api/json only, never builds anything.

import { createItem } from '../items.mjs';
import { plural, rank } from '../rules.mjs';
import { daysSince, jsonClient, selfHostedUrl, tokenSetup } from './web.mjs';

export const id = 'jenkins';
export const name = 'Jenkins';
export const description = 'Jobs whose last build failed, in a view or folder you pick (optionally only builds you broke or started).';
export const enabledByDefault = false;
export const secretFields = Object.freeze({ token: 'jenkins-token' });
export const setup = tokenSetup({
  fields: [
    { key: 'url', label: 'Jenkins, view or folder address', placeholder: 'https://jenkins.internal/view/payments' },
    { key: 'username', label: 'Your Jenkins username', placeholder: 'sam' },
    { key: 'onlyMine', label: 'Only builds you started or broke (yes / no)', placeholder: 'no', optional: true },
  ],
  token: { label: 'API token', help: 'https://www.jenkins.io/doc/book/using/remote-access-api/', placeholder: 'from your name → Security → API Token' },
  notes: 'Point it at a view or folder so it watches your jobs, not the whole server. A Jenkins on your office network or VPN works while your computer can reach it.',
});

const BUILD = 'number,result,timestamp,url,culprits[fullName,id],actions[causes[userId,userName]]';
const JOB = `name,fullName,url,color,_class,lastCompletedBuild[${BUILD}]`;
export const TREE = `jobs[${JOB},jobs[${JOB}]]`;
const FAILED = new Set(['FAILURE', 'UNSTABLE']);
const MAX_JOBS = 400;

export function normalizeSettings(input = {}) {
  const url = selfHostedUrl(input.url, 'Jenkins').replace(/\/api\/json$/, '');
  const username = String(input.username ?? '').trim();
  if (!username || /\s/.test(username)) throw new TypeError('Enter your Jenkins username (the one in your profile URL)');
  const onlyMine = /^(yes|y|true|on|1)$/i.test(String(input.onlyMine ?? '').trim()) || input.onlyMine === true;
  return { url, username, onlyMine };
}

async function client(config, ctx) {
  if (!config.url || !config.username) throw new Error('Add the Jenkins address and your username in setup.');
  const token = await ctx.secret?.(secretFields.token);
  if (!token) throw new Error('Add your Jenkins API token in setup.');
  const basic = Buffer.from(`${config.username}:${token}`).toString('base64');
  return jsonClient({ fetchImpl: ctx.fetch ?? fetch, label: new URL(config.url).host, headers: { authorization: `Basic ${basic}` }, fix: 'Make a new API token in Jenkins (your name → Security) and update it in setup.' });
}

/** Leaf jobs, with the folder or multibranch parent they sit in. */
export function leafJobs(jobs, parent = null, out = []) {
  for (const j of jobs ?? []) {
    if (out.length >= MAX_JOBS) break;
    if (Array.isArray(j.jobs) && j.jobs.length) leafJobs(j.jobs, j, out);
    else if (j.lastCompletedBuild || j.color) out.push({ job: j, parent });
  }
  return out;
}

/** Did you start this build, or are you among its culprits? */
export function involves(build, username) {
  const me = String(username).toLowerCase();
  if ((build?.culprits ?? []).some((c) => String(c.id ?? '').toLowerCase() === me || String(c.fullName ?? '').toLowerCase() === me)) return true;
  return (build?.actions ?? []).some((a) => (a?.causes ?? []).some((c) => String(c.userId ?? '').toLowerCase() === me));
}

export async function test(config = {}, ctx = {}) {
  try {
    const http = await client(config, ctx);
    const r = await http.get(`${config.url}/api/json?tree=${encodeURIComponent(TREE)}`);
    const jobs = leafJobs(r?.jobs);
    return { ok: true, message: `Connected to Jenkins at ${new URL(config.url).host} · watching ${plural(jobs.length, 'job')}` };
  } catch (err) { return { ok: false, message: err.message }; }
}

export async function collect(config = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const http = await client(config, ctx);
  const r = await http.get(`${config.url}/api/json?tree=${encodeURIComponent(TREE)}`);
  const jobs = leafJobs(r?.jobs);
  const items = [];
  for (const { job, parent } of jobs) {
    const b = job.lastCompletedBuild;
    if (!b || !FAILED.has(b.result) || job.color === 'disabled') continue;
    if (config.onlyMine && !involves(b, config.username)) continue;
    const multibranch = /MultiBranch|Organization/i.test(parent?._class ?? '');
    const workflow = multibranch ? (parent.fullName ?? parent.name) : (job.fullName ?? job.name);
    const branch = multibranch ? decodeURIComponent(job.name) : `#${b.number}`;
    const at = new Date(Number(b.timestamp) || now).toISOString();
    const s = { workflow, branch, ageDays: daysSince(now, at), note: config.onlyMine ? 'you started or broke it' : 'the job\'s latest build' };
    const rk = rank('ci-failure', s);
    const culprits = (b.culprits ?? []).map((c) => c.fullName ?? c.id).filter(Boolean);
    items.push(createItem({
      id: `jenkins:${job.url ?? job.fullName}`, source: id, kind: 'ci-failure', title: `${workflow}${multibranch ? ` · ${branch}` : ''} · build #${b.number} ${b.result === 'UNSTABLE' ? 'unstable' : 'failed'}`,
      url: /^https?:\/\//.test(b.url ?? '') ? b.url : null, why: b.result === 'UNSTABLE' ? rk.why.replace('still failing', 'still unstable').replace('failed', 'is unstable') : rk.why, urgency: rk.urgency, updatedAt: at,
      meta: { rule: rk.rule, fingerprint: String(b.number), fields: { Job: job.fullName ?? job.name, Build: `#${b.number}`, Result: b.result.toLowerCase(), Culprits: culprits.join(', ') || 'none listed' } },
    }));
  }
  ctx.summary?.(`${plural(jobs.length, 'job')} watched · ${items.length} failing`);
  return items;
}
