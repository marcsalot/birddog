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

export const RULES = [
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
