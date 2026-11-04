// Ranking rules. Deliberately boring: a list, checked top to bottom, first match wins.
// Each rule says what urgency it gives and writes the "why" line you see in the inbox,
// so there is never a mystery score. Order also breaks ties inside an urgency group.
//
// A rule: { id, kind, text, urgency, when(signal) → boolean, why(signal) → string }

import { URGENCIES } from './items.mjs';

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function ago(days) {
  if (days < 1 / 24) return 'a few minutes';
  if (days < 1) return plural(Math.max(1, Math.round(days * 24)), 'hour');
  if (days < 14) return plural(Math.floor(days), 'day');
  if (days < 60) return plural(Math.floor(days / 7), 'week');
  return plural(Math.floor(days / 30), 'month');
}

/** "in 2 days", "today", "2 days ago": for deadlines. `days` is time left (negative = past). */
export function until(days) {
  if (days < 0) return `${ago(-days)} ago`;
  if (days < 1) return 'today';
  if (days < 2) return 'tomorrow';
  return `in ${plural(Math.floor(days), 'day')}`;
}

const who = (login) => (login ? `**@${login}**` : 'Someone');
const list = (names, max = 3) => names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '');

// Order matters twice: first match wins, and inside an urgency group earlier rules
// sort first. People waiting on you come before deadlines, deadlines before hygiene.
export const RULES = [
  // ---- GitHub: review requests ------------------------------------------------
  {
    id: 'review-waiting', kind: 'review-request', urgency: 'now',
    text: 'Review requested of you over a day ago → Now',
    when: (s) => !s.draft && !s.team && s.ageDays >= 1,
    why: (s) => `${who(s.requester)} requested your review **${ago(s.ageDays)}** ago · they are waiting on you`,
  },
  {
    id: 'issue-overdue', kind: 'issue', urgency: 'now',
    text: 'Assigned issue in a milestone that is past due → Now',
    when: (s) => s.dueDays !== null && s.dueDays < 0,
    why: (s) => `Milestone **${s.milestone}** was due **${until(s.dueDays)}** · assigned to you`,
  },
  // ---- Jira: deadlines that have passed or end today ---------------------------
  {
    id: 'jira-overdue', kind: 'jira-issue', urgency: 'now',
    text: 'Jira ticket past its due date → Now',
    when: (s) => s.dueDays !== null && s.dueDays < 0,
    why: (s) => `**Overdue** · was due **${until(s.dueDays)}**${s.status ? ` and is still ${s.status}` : ''}`,
  },
  {
    id: 'jira-sprint-ending', kind: 'jira-issue', urgency: 'now',
    text: 'Sprint ends within a day and the ticket is not done → Now',
    when: (s) => s.sprintDays !== null && s.sprintDays < 1,
    why: (s) => `Sprint **${s.sprint}** ends **${until(s.sprintDays)}** · still ${s.status}`,
  },
  // ---- GitHub: today ---------------------------------------------------------
  {
    id: 'review-request', kind: 'review-request', urgency: 'today',
    text: 'Fresh review request for you → Today',
    when: (s) => !s.draft && !s.team,
    why: (s) => `${who(s.requester)} requested your review **${ago(s.ageDays)}** ago`,
  },
  {
    id: 'pr-changes-requested', kind: 'my-pr', urgency: 'today',
    text: 'Your PR has changes requested → Today',
    when: (s) => !s.draft && s.changesBy.length > 0,
    why: (s) => `${s.changesBy.map(who).slice(0, 2).join(' and ')}${s.changesBy.length > 2 ? ` +${s.changesBy.length - 2}` : ''} requested changes **${ago(s.ageDays)}** ago · address the feedback`,
  },
  {
    id: 'pr-checks-failing', kind: 'my-pr', urgency: 'today',
    text: 'Your PR has failing checks → Today',
    when: (s) => !s.draft && s.failing.length > 0,
    why: (s) => `**${plural(s.failing.length, 'check')} failing**: ${list(s.failing)} · fix before reviewers look`,
  },
  {
    id: 'pr-conflict', kind: 'my-pr', urgency: 'today',
    text: 'Your PR has merge conflicts → Today',
    when: (s) => !s.draft && s.conflict,
    why: (s) => `**Merge conflicts** with ${s.base ? `**${s.base}**` : 'its base branch'} · merge or rebase to unblock it`,
  },
  {
    id: 'issue-due-soon', kind: 'issue', urgency: 'today',
    text: 'Assigned issue in a milestone due within 3 days → Today',
    when: (s) => s.dueDays !== null && s.dueDays < 3,
    why: (s) => `Milestone **${s.milestone}** is due **${until(s.dueDays)}** · assigned to you`,
  },
  {
    id: 'issue-priority', kind: 'issue', urgency: 'today',
    text: 'Assigned issue labeled urgent, critical, P0 or P1 → Today',
    when: (s) => s.priorityLabels.length > 0,
    why: (s) => `Labeled **${list(s.priorityLabels, 2)}** · assigned to you`,
  },
  {
    id: 'mention-fresh', kind: 'mention', urgency: 'today',
    text: 'Unread @mention from the last 3 days → Today',
    when: (s) => s.ageDays < 3,
    why: (s) => `${who(s.by)} mentioned ${s.team ? 'your team' : 'you'} **${ago(s.ageDays)}** ago`,
  },
  // ---- Jira: today -------------------------------------------------------------
  {
    id: 'jira-blocked', kind: 'jira-issue', urgency: 'today',
    text: 'Your Jira ticket is blocked or flagged → Today',
    when: (s) => s.blockedBy.length > 0 || s.flagged || s.blockedStatus,
    why: (s) => (s.blockedBy.length
      ? `**Blocked** by ${list(s.blockedBy)} · chase it or pick up something else`
      : s.flagged ? '**Flagged** as an impediment · find out what it needs'
        : `Status is **${s.status}** · find out what it is waiting for`),
  },
  {
    id: 'jira-due-soon', kind: 'jira-issue', urgency: 'today',
    text: 'Jira ticket due within 3 days → Today',
    when: (s) => s.dueDays !== null && s.dueDays < 3,
    why: (s) => `Due **${until(s.dueDays)}** · ${s.status}`,
  },
  {
    id: 'jira-sprint-ending-soon', kind: 'jira-issue', urgency: 'today',
    text: 'Sprint ends within 3 days and the ticket is not done → Today',
    when: (s) => s.sprintDays !== null && s.sprintDays < 3,
    why: (s) => `Sprint **${s.sprint}** ends **${until(s.sprintDays)}** · still ${s.status}`,
  },
  {
    id: 'jira-high-priority', kind: 'jira-issue', urgency: 'today',
    text: 'High, Highest, Critical or Blocker priority → Today',
    when: (s) => /^(highest|high|critical|blocker|urgent|p0|p1)$/i.test(s.priority ?? ''),
    why: (s) => `**${s.priority}** priority · ${s.status}`,
  },
  // ---- GitHub & Jira: later --------------------------------------------------
  {
    id: 'review-other', kind: 'review-request', urgency: 'later',
    text: 'Review requested of your team, or on a draft → Later',
    when: () => true,
    why: (s) => (s.team
      ? `${who(s.requester)} asked **${s.team}** for a review **${ago(s.ageDays)}** ago`
      : `Draft PR · ${who(s.requester)} requested your review **${ago(s.ageDays)}** ago`),
  },
  {
    id: 'pr-draft-problems', kind: 'my-pr', urgency: 'later',
    text: 'Your draft PR has failing checks, conflicts or change requests → Later',
    when: () => true,
    why: (s) => `Draft · ${[
      s.changesBy.length && 'changes requested',
      s.failing.length && plural(s.failing.length, 'check') + ' failing',
      s.conflict && 'merge conflicts',
    ].filter(Boolean).join(', ')}`,
  },
  {
    id: 'mention', kind: 'mention', urgency: 'later',
    text: 'Older unread @mention → Later',
    when: () => true,
    why: (s) => `${who(s.by)} mentioned ${s.team ? 'your team' : 'you'} **${ago(s.ageDays)}** ago · still unread on GitHub`,
  },
  {
    id: 'issue-assigned', kind: 'issue', urgency: 'later',
    text: 'Other open issues assigned to you → Later',
    when: () => true,
    why: (s) => `Assigned to you · last activity **${ago(s.ageDays)}** ago`,
  },
  {
    id: 'jira-assigned', kind: 'jira-issue', urgency: 'later',
    text: 'Other open Jira tickets assigned to you → Later',
    when: () => true,
    why: (s) => `**${s.status}** · last updated **${ago(s.ageDays)}** ago`,
  },
  // ---- Local git ---------------------------------------------------------------
  {
    id: 'unpushed-old', kind: 'unpushed', urgency: 'now',
    text: 'Unpushed commits older than 3 days → Now',
    when: (s) => s.ageDays >= 3,
    why: (s) => `**${plural(s.count, 'commit')}** only on this machine for **${ago(s.ageDays)}** · push to back them up`,
  },
  {
    id: 'unpushed', kind: 'unpushed', urgency: 'today',
    text: 'Unpushed commits older than 1 day → Today',
    when: (s) => s.ageDays >= 1,
    why: (s) => `${s.hasUpstream ? 'Ahead of the remote' : '**Never pushed**'} · oldest commit **${ago(s.ageDays)}** old`,
  },
  {
    id: 'unpushed-fresh', kind: 'unpushed', urgency: 'later',
    text: 'Fresh unpushed commits → Later',
    when: () => true,
    why: (s) => `${s.hasUpstream ? 'Ahead of the remote' : 'Not pushed yet'} · committed **${ago(s.ageDays)}** ago`,
  },
  {
    id: 'uncommitted-old', kind: 'uncommitted', urgency: 'today',
    text: 'Uncommitted edits older than 3 days → Today',
    when: (s) => s.tracked > 0 && s.ageDays >= 3,
    why: (s) => `Edits sitting uncommitted for **${ago(s.ageDays)}** · commit or stash before they get lost`,
  },
  {
    id: 'uncommitted', kind: 'uncommitted', urgency: 'later',
    text: 'Recent uncommitted edits → Later',
    when: (s) => s.tracked > 0,
    why: (s) => `Working tree changed **${ago(s.ageDays)}** ago${s.untracked ? ` · plus ${plural(s.untracked, 'new file')}` : ''}`,
  },
  {
    id: 'untracked', kind: 'uncommitted', urgency: 'later',
    text: 'Only untracked files → Later',
    when: () => true,
    why: (s) => `**${plural(s.untracked, 'untracked file')}** · commit, ignore or delete`,
  },
  {
    id: 'merged-branches', kind: 'merged-branches', urgency: 'later',
    text: 'Local branches already merged → Later',
    when: () => true,
    why: (s) => `Already merged into **${s.base}** · safe to delete`,
  },
  {
    id: 'stale-branches', kind: 'stale-branches', urgency: 'later',
    text: 'Unmerged branches with no commits for a while → Later',
    when: () => true,
    why: (s) => s.gone
      ? `Remote branch deleted${s.gone < s.count ? ` for ${s.gone}` : ''} · oldest untouched **${ago(s.oldestDays)}**`
      : `No commits in **${ago(s.oldestDays)}** · finish, rebase or delete`,
  },
];

for (const r of RULES) {
  if (!URGENCIES.includes(r.urgency)) throw new Error(`rule ${r.id} has bad urgency ${r.urgency}`);
}

/**
 * Rank a signal. Returns { urgency, why, rule: { id, text, order } }.
 * Throws if no rule handles the kind, so a new source can't silently skip ranking.
 */
export function rank(kind, signal, rules = RULES) {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.kind === kind && r.when(signal)) {
      return { urgency: r.urgency, why: r.why(signal), rule: { id: r.id, text: r.text, order: i } };
    }
  }
  throw new Error(`no ranking rule for kind "${kind}"`);
}
