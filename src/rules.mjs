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

/** A due date in whole days: "yesterday", "3 days ago", "today", "tomorrow", "in 4 days". */
export function dueWhen(days) {
  if (days < 0) { const n = Math.ceil(-days); return n === 1 ? 'yesterday' : `${n} days ago`; }
  return until(days);
}

const who = (login) => (login ? `**@${login}**` : 'Someone');
const list = (names, max = 3) => names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '');

// Order matters twice: first match wins, and inside an urgency group earlier rules
// sort first. People waiting on you come before deadlines, deadlines before hygiene.
/** "14:30" in this machine's time zone. */
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const mins = (ms) => plural(Math.max(1, Math.round(ms / 60_000)), 'minute');

const n = (x, w) => plural(x, w);

export const RULES = [
  // ---- Incidents: nothing beats a page ------------------------------------------
  {
    id: 'incident-triggered', kind: 'incident', urgency: 'now',
    text: 'Incident triggered and assigned to you → Now',
    when: (s) => s.status === 'triggered',
    why: (s) => `**Triggered** ${s.ageDays < 1 / 24 ? mins(s.ageDays * 86_400_000) : ago(s.ageDays)} ago${s.urgencyLevel === 'high' ? ' · **high urgency**' : ''}${s.service ? ` · ${s.service}` : ''} · acknowledge it`,
  },
  {
    id: 'alert-critical', kind: 'alert', urgency: 'now',
    text: 'Critical alert or problem firing (Dynatrace, Grafana) → Now',
    when: (s) => s.critical,
    why: (s) => `**Firing** ${s.ageDays < 1 / 24 ? mins(s.ageDays * 86_400_000) : ago(s.ageDays)} · **${s.severity}**${s.what ? ` · ${s.what}` : ''}`,
  },
  // ---- Calendar: right now ------------------------------------------------------
  {
    id: 'meeting-now', kind: 'meeting', urgency: 'now',
    text: 'Meeting in progress or starting within 15 minutes → Now',
    when: (s) => !s.allDay && s.startsIn <= 15 * 60_000 && s.endsIn > 0,
    why: (s) => (s.startsIn > 0
      ? `Starts **in ${mins(s.startsIn)}**${s.where ? ` · ${s.where}` : ''}`
      : `**Happening now** · started ${mins(-s.startsIn)} ago, ends at ${clock(s.end)}`),
  },
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
    id: 'jira-overdue', kind: 'ticket', urgency: 'now',
    text: 'Ticket past its due date → Now',
    when: (s) => s.dueDays !== null && s.dueDays < 0,
    why: (s) => `**Overdue** · was due **${until(s.dueDays)}**${s.status ? ` and is still ${s.status}` : ''}`,
  },
  {
    id: 'jira-sprint-ending', kind: 'ticket', urgency: 'now',
    text: 'Sprint or cycle ends within a day and the ticket is not done → Now',
    when: (s) => s.sprintDays !== null && s.sprintDays < 1,
    why: (s) => `Sprint **${s.sprint}** ends **${until(s.sprintDays)}** · still ${s.status}`,
  },
  // ---- Calendar: later today ----------------------------------------------------
  {
    id: 'meeting-today', kind: 'meeting', urgency: 'today',
    text: 'Meeting later today → Today',
    when: (s) => !s.allDay && s.today,
    why: (s) => `Starts at **${clock(s.start)}** (in ${s.startsIn < 3_600_000 ? mins(s.startsIn) : ago(s.startsIn / 86_400_000)})${s.where ? ` · ${s.where}` : ''}`,
  },
  // ---- On call, incidents, CI, errors, security, chat: today --------------------
  {
    id: 'incident-acknowledged', kind: 'incident', urgency: 'today',
    text: 'Incident you acknowledged that is still open → Today',
    when: () => true,
    why: (s) => `**Acknowledged**, still open for ${ago(s.ageDays)}${s.service ? ` · ${s.service}` : ''}`,
  },
  {
    id: 'on-call-now', kind: 'on-call', urgency: 'today',
    text: 'You are on call right now → Today',
    when: (s) => s.startsIn <= 0,
    why: (s) => `You're **on call**${s.policy ? ` for ${s.policy}` : ''} until **${s.endLabel}**`,
  },
  {
    id: 'alert-firing', kind: 'alert', urgency: 'today',
    text: 'Other alert or problem firing for under 3 days → Today',
    when: (s) => s.ageDays < 3,
    why: (s) => `Firing for **${ago(s.ageDays)}** · ${s.severity}${s.what ? ` · ${s.what}` : ''}`,
  },
  {
    id: 'ci-failing', kind: 'ci-failure', urgency: 'today',
    text: 'CI failing on a branch you pushed in the last 2 days → Today',
    when: (s) => s.ageDays < 2,
    why: (s) => `**${s.workflow}** failed on **${s.branch}** ${ago(s.ageDays)} ago · ${s.note ?? "it's your latest run there"}`,
  },
  {
    id: 'security-critical', kind: 'security-alert', urgency: 'today',
    text: 'Critical or high security alert on your repo → Today',
    when: (s) => s.severity === 'critical' || s.severity === 'high',
    why: (s) => `**${s.severity[0].toUpperCase()}${s.severity.slice(1)}** vulnerability in **${s.package}**${s.fixAvailable ? ' · a fix is available' : ''}`,
  },
  {
    id: 'error-regressed', kind: 'error-issue', urgency: 'today',
    text: 'Error assigned to you that regressed or is new → Today',
    when: (s) => s.regressed || s.newDays < 2,
    why: (s) => `${s.regressed ? '**Regressed**' : '**New**'} · ${n(s.count, 'event')}${s.users ? `, ${n(s.users, 'user')}` : ''} · last seen ${ago(s.lastSeenDays)} ago`,
  },
  {
    id: 'dm-waiting', kind: 'dm', urgency: 'today',
    text: 'Direct message waiting for your reply, under 2 days old → Today',
    when: (s) => s.ageDays < 2,
    why: (s) => `${who(s.by)} messaged you **${ago(s.ageDays)}** ago · waiting for your reply`,
  },
  {
    id: 'task-overdue', kind: 'task', urgency: 'today',
    text: 'Task past its due date → Today',
    when: (s) => s.dueDays !== null && s.dueDays < 0,
    why: (s) => `**Overdue**, due ${dueWhen(s.dueDays)}${s.list ? ` · ${s.list}` : ''}`,
  },
  {
    id: 'task-due-today', kind: 'task', urgency: 'today',
    text: 'Task due today → Today',
    when: (s) => s.dueDays !== null && s.dueDays < 1,
    why: (s) => `Due **today**${s.list ? ` · ${s.list}` : ''}`,
  },
  {
    id: 'task-important', kind: 'task', urgency: 'today',
    text: 'Task marked important or top priority → Today',
    when: (s) => s.important,
    why: (s) => `Marked **${s.importantLabel ?? 'important'}**${s.dueDays !== null ? ` · due ${dueWhen(s.dueDays)}` : ''}${s.list ? ` · ${s.list}` : ''}`,
  },
  {
    id: 'email-starred', kind: 'email', urgency: 'today',
    text: 'Starred email you haven\'t replied to → Today',
    when: (s) => s.starred && !s.replied,
    why: (s) => `**Starred** · from ${s.by ? `**${s.by}**` : 'someone'} ${ago(s.ageDays)} ago · not replied yet`,
  },
  {
    id: 'email-unread-fresh', kind: 'email', urgency: 'today',
    text: 'Unread email that needs you, from the last day → Today',
    when: (s) => s.unread && s.ageDays < 1 && (s.verdict ?? 'needs-you') === 'needs-you',
    why: (s) => `Unread · from ${s.by ? `**${s.by}**` : 'someone'} **${ago(s.ageDays)}** ago${s.reason ? ` · ${s.reason}` : ''}`,
  },
  {
    id: 'email-needs-you', kind: 'email', urgency: 'today',
    text: 'Unread email that needs you, under 3 days old → Today',
    when: (s) => s.unread && s.ageDays < 3 && (s.verdict ?? 'needs-you') === 'needs-you',
    why: (s) => `Unread for **${ago(s.ageDays)}** · from ${s.by ? `**${s.by}**` : 'someone'}${s.reason ? ` · ${s.reason}` : ''}`,
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
    id: 'rebase-conflicts', kind: 'rebase-request', urgency: 'today',
    text: 'Your PR has merge conflicts with its target branch → Today',
    when: (s) => !s.draft && s.conflict,
    why: (s) => `**Merge conflicts** with **${s.targetBranch}** · rebase or merge to unblock it`,
  },
  {
    id: 'reply-owed', kind: 'reply-owed', urgency: 'today',
    text: 'Open review thread on your PR where the reviewer spoke last → Today',
    when: () => true,
    why: (s) => `${s.threadCount > 1 ? `**${plural(s.threadCount, 'open thread')}**` : '**Open thread**'} waiting for your reply${s.by ? ` · ${who(s.by)} spoke last` : ''}${s.ageDays >= 1 ? ` · ${ago(s.ageDays)} ago` : ''}`,
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
  {
    id: 'pr-ready', kind: 'pr-ready', urgency: 'today',
    text: 'Your PR has all required approvals and is ready to merge → Today',
    when: () => true,
    why: (s) => `**Ready to merge** into **${s.targetBranch}**${s.approverCount ? ` · ${plural(s.approverCount, 'approval')}` : ''}`,
  },
  // ---- Jira: today -------------------------------------------------------------
  {
    id: 'jira-blocked', kind: 'ticket', urgency: 'today',
    text: 'Your ticket is blocked or flagged → Today',
    when: (s) => s.blockedBy.length > 0 || s.flagged || s.blockedStatus,
    why: (s) => (s.blockedBy.length
      ? `**Blocked** by ${list(s.blockedBy)} · chase it or pick up something else`
      : s.flagged ? '**Flagged** as an impediment · find out what it needs'
        : `Status is **${s.status}** · find out what it is waiting for`),
  },
  {
    id: 'unblock-done', kind: 'unblock', urgency: 'today',
    text: 'A ticket blocking yours has reached Done → Today',
    when: (s) => s.done,
    why: (s) => `**${s.blockerKey}** is now **${s.blockerStatus}** · your blocker may be resolved`,
  },
  {
    id: 'no-progress', kind: 'no-progress', urgency: 'today',
    text: 'Ticket in development with no commits for several days → Today',
    when: () => true,
    why: (s) => s.days === null
      ? `**${s.status}** · no matching branch found locally · start a worktree or update the ticket`
      : `**${s.status}** for ${plural(s.days, 'day')} with no commits · commit, update, or move it back`,
  },
  {
    id: 'jira-due-soon', kind: 'ticket', urgency: 'today',
    text: 'Ticket due within 3 days → Today',
    when: (s) => s.dueDays !== null && s.dueDays < 3,
    why: (s) => `Due **${until(s.dueDays)}** · ${s.status}`,
  },
  {
    id: 'jira-sprint-ending-soon', kind: 'ticket', urgency: 'today',
    text: 'Sprint or cycle ends within 3 days and the ticket is not done → Today',
    when: (s) => s.sprintDays !== null && s.sprintDays < 3,
    why: (s) => `Sprint **${s.sprint}** ends **${until(s.sprintDays)}** · still ${s.status}`,
  },
  {
    id: 'jira-high-priority', kind: 'ticket', urgency: 'today',
    text: 'High, Highest, Urgent, Critical or Blocker priority → Today',
    when: (s) => /^(highest|high|critical|blocker|urgent|p0|p1)$/i.test(s.priority ?? ''),
    why: (s) => `**${s.priority}** priority · ${s.status}`,
  },
  // ---- GitHub, Jira & Calendar: later -----------------------------------------
  {
    id: 'on-call-soon', kind: 'on-call', urgency: 'later',
    text: 'Your on-call shift starts within a day → Later',
    when: () => true,
    why: (s) => `Your **on-call** shift${s.policy ? ` for ${s.policy}` : ''} starts **${s.startLabel}**`,
  },
  {
    id: 'alert-old', kind: 'alert', urgency: 'later',
    text: 'Alert or problem open for days → Later',
    when: () => true,
    why: (s) => `Still firing after ${ago(s.ageDays)} · ${s.severity}${s.what ? ` · ${s.what}` : ''}`,
  },
  {
    id: 'ci-failing-old', kind: 'ci-failure', urgency: 'later',
    text: 'Older CI failure that is still your latest run → Later',
    when: () => true,
    why: (s) => `**${s.workflow}** still failing on **${s.branch}** (since ${ago(s.ageDays)} ago)`,
  },
  {
    id: 'security-other', kind: 'security-alert', urgency: 'later',
    text: 'Medium or low security alert → Later',
    when: () => true,
    why: (s) => `${s.severity[0].toUpperCase()}${s.severity.slice(1)} vulnerability in **${s.package}**${s.fixAvailable ? ' · a fix is available' : ''}`,
  },
  {
    id: 'error-assigned', kind: 'error-issue', urgency: 'later',
    text: 'Other unresolved errors assigned to you → Later',
    when: () => true,
    why: (s) => `Unresolved · ${n(s.count, 'event')} · last seen ${ago(s.lastSeenDays)} ago`,
  },
  {
    id: 'dm-old', kind: 'dm', urgency: 'later',
    text: 'Older direct message you have not answered → Later',
    when: () => true,
    why: (s) => `${who(s.by)} messaged you ${ago(s.ageDays)} ago · still unanswered`,
  },
  {
    id: 'task', kind: 'task', urgency: 'later',
    text: 'Other open task (due soon, or no date) → Later',
    when: () => true,
    why: (s) => `${s.dueDays !== null ? `Due ${dueWhen(s.dueDays)}` : 'No due date'}${s.list ? ` · ${s.list}` : ''}`,
  },
  {
    id: 'email-fyi', kind: 'email', urgency: 'later',
    text: 'Email that is only FYI (CC, lists) or probably noise → Later',
    when: (s) => s.verdict === 'fyi' || s.verdict === 'noise',
    why: (s) => `${s.verdict === 'noise' ? 'Probably noise' : 'FYI'} · from ${s.by ? `**${s.by}**` : 'someone'} ${ago(s.ageDays)} ago${s.reason ? ` · ${s.reason}` : ''}`,
  },
  {
    id: 'email-unread', kind: 'email', urgency: 'later',
    text: 'Older unread email → Later',
    when: () => true,
    why: (s) => `${s.unread ? 'Unread' : 'Starred'} · from ${s.by ? `**${s.by}**` : 'someone'} ${ago(s.ageDays)} ago`,
  },
  {
    id: 'meeting-all-day', kind: 'meeting', urgency: 'later',
    text: 'All-day event today → Later',
    when: (s) => s.allDay && s.today,
    why: () => '**All day** today',
  },
  {
    id: 'meeting-tomorrow', kind: 'meeting', urgency: 'later',
    text: 'Meeting tomorrow → Later',
    when: () => true,
    why: (s) => (s.allDay ? '**All day** tomorrow' : `Tomorrow at **${clock(s.start)}**${s.where ? ` · ${s.where}` : ''}`),
  },
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
    id: 'rebase-behind', kind: 'rebase-request', urgency: 'later',
    text: 'Your PR is behind its target branch → Later',
    when: () => true,
    why: (s) => s.draft
      ? `Draft · ${s.commitsBehind > 0 ? `${plural(s.commitsBehind, 'commit')} behind` : 'behind'} **${s.targetBranch}**`
      : `**${s.commitsBehind > 0 ? `${plural(s.commitsBehind, 'commit')} behind` : 'Behind'} ${s.targetBranch}** · rebase before you merge`,
  },
  {
    id: 'mention', kind: 'mention', urgency: 'later',
    text: 'Older unread @mention → Later',
    when: () => true,
    why: (s) => `${who(s.by)} mentioned ${s.team ? 'your team' : 'you'} **${ago(s.ageDays)}** ago · ${s.where === 'Discord' ? 'no reply from you since' : s.where ? `still waiting in ${s.where}` : 'still unread on GitHub'}`,
  },
  {
    id: 'issue-assigned', kind: 'issue', urgency: 'later',
    text: 'Other open issues assigned to you → Later',
    when: () => true,
    why: (s) => `Assigned to you · last activity **${ago(s.ageDays)}** ago`,
  },
  {
    id: 'jira-assigned', kind: 'ticket', urgency: 'later',
    text: 'Other open tickets assigned to you → Later',
    when: () => true,
    why: (s) => `**${s.status}** · last updated **${ago(s.ageDays)}** ago`,
  },
  {
    id: 'unblock-advancing', kind: 'unblock', urgency: 'later',
    text: 'A ticket blocking yours is advancing toward completion → Later',
    when: () => true,
    why: (s) => `**${s.blockerKey}** moved to **${s.blockerStatus}** · check if you can proceed`,
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
