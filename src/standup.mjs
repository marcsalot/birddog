// Standup text generator.
//
// generateStandup(snapshot, acks, opts) → plain ASCII string with three sections:
//   Yesterday / Today  — items marked done since the last working day
//   In progress        — open items at Now/Today urgency, excluding blocked tickets
//   Blockers           — items waiting on something (jira-blocked, rebase-conflicts, unblock-done)
//
// lastWorkingDaySince(now) — pure function; returns epoch ms of midnight at the start
//   of the previous working day: last Monday's midnight if today is Monday, else yesterday's.

/** Remove **bold** markers from a why string; leave the content. */
function stripBold(s) {
  return String(s ?? '').replace(/\*\*/g, '');
}

/**
 * Returns the epoch ms of midnight (UTC) at the start of the previous working day:
 *   - If today is Monday: last Monday's midnight (seven days back).
 *   - Otherwise: yesterday's midnight.
 * @param {number} now  millisecond timestamp
 * @returns {number}
 */
export function lastWorkingDaySince(now) {
  const d = new Date(now);
  const todayStartUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, …, 6 = Saturday
  if (day === 1) {
    // Monday: look back a full week so the weekend is covered
    return todayStartUtc - 7 * 86_400_000;
  }
  // All other days: just yesterday
  return todayStartUtc - 86_400_000;
}

// Rule ids that belong in the Blockers section.
const BLOCKER_RULE_IDS = new Set(['jira-blocked', 'rebase-conflicts', 'unblock-done']);

/**
 * Build a paste-ready plain ASCII standup string.
 *
 * @param {{ items: object[], sources: object[], refreshedAt: string }} snapshot
 *   The collector snapshot.  Items are raw (no triage status).
 * @param {Map<string, { status: string, doneAt: number|null }>} acks
 *   Triage decisions keyed by item id.  Build this from triage.data.items in the server.
 * @param {{ now?: number }} [opts]
 * @returns {string}  Three-section plain ASCII text.
 */
export function generateStandup(snapshot, acks, { now = Date.now() } = {}) {
  const cutoff = lastWorkingDaySince(now);
  const items = snapshot?.items ?? [];

  // Quick lookup by id
  const byId = new Map(items.map((it) => it && [it.id, it]).filter(Boolean));

  // ---- Done section ----
  // Items in acks with status=done and doneAt >= cutoff, still present in snapshot.
  const doneItems = [];
  for (const [id, ack] of acks) {
    if (ack.status !== 'done') continue;
    const ts = typeof ack.doneAt === 'number' ? ack.doneAt
      : typeof ack.doneAt === 'string' ? Date.parse(ack.doneAt) : null;
    if (ts == null || Number.isNaN(ts) || ts < cutoff) continue;
    const item = byId.get(id);
    if (item) doneItems.push(item);
  }
  // Group by source (sort by source, then title)
  doneItems.sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title));

  // ---- In progress section ----
  // Open items at urgency now/today, excluding blocked tickets and triaged (done/snoozed) items.
  const inProgress = items
    .filter((it) => {
      if (it.urgency !== 'now' && it.urgency !== 'today') return false;
      const st = acks.get(it.id)?.status;
      if (st === 'done' || st === 'snoozed') return false;
      // Exclude blocked Jira tickets (they belong in Blockers instead)
      if (it.kind === 'ticket' && it.meta?.rule?.id === 'jira-blocked') return false;
      return true;
    })
    .slice(0, 10);

  // ---- Blockers section ----
  // Open items whose rule is one of the known blocker signals.
  const blockers = items
    .filter((it) => {
      if (!BLOCKER_RULE_IDS.has(it.meta?.rule?.id)) return false;
      const st = acks.get(it.id)?.status;
      if (st === 'done' || st === 'snoozed') return false;
      return true;
    })
    .slice(0, 5);

  // ---- Format ----
  const lines = [];

  lines.push('Yesterday / Today');
  if (doneItems.length === 0) {
    lines.push('(nothing marked done)');
  } else {
    for (const it of doneItems) {
      lines.push(`- ${it.title.trim()}`);
    }
  }

  lines.push('');
  lines.push('In progress');
  if (inProgress.length === 0) {
    lines.push('(nothing active)');
  } else {
    for (const it of inProgress) {
      const whyText = it.why ? ` \u00b7 ${stripBold(it.why).trim()}` : '';
      lines.push(`- ${it.title.trim()}${whyText}`);
    }
  }

  lines.push('');
  lines.push('Blockers');
  if (blockers.length === 0) {
    lines.push('(none)');
  } else {
    for (const it of blockers) {
      const whyText = it.why ? ` \u00b7 ${stripBold(it.why).trim()}` : '';
      lines.push(`- ${it.title.trim()}${whyText}`);
    }
  }

  return lines.join('\n');
}
