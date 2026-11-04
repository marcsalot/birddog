// The one shape every source produces.
//
//   Item {
//     id        stable string, unique across sources ("git:unpushed:3f9a…")
//     source    source id ("git")
//     kind      what sort of thing it is ("unpushed", "uncommitted", …)
//     title     one line, human readable
//     url       http(s) link to open, or null
//     why       one line explaining why it is in your list. **bold** is allowed.
//     urgency   'now' | 'today' | 'later'
//     updatedAt ISO timestamp of the last activity
//     meta      free-form extras. Conventions the UI understands:
//                 fields       { label: value } shown in the details drawer
//                 rule         { id, text, order } the ranking rule that fired
//                 command      a suggested shell command (copy button)
//                 path         a local path (copy button)
//                 fingerprint  changes when the item meaningfully changes;
//                              "done" and "snooze until it changes" use it
//   }

export const URGENCIES = Object.freeze(['now', 'today', 'later']);

export class ItemError extends Error {}

function req(fields, key, type) {
  const v = fields[key];
  if (typeof v !== type || (type === 'string' && !v.trim())) {
    throw new ItemError(`item.${key} must be a non-empty ${type} (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Validate and normalize an item. Throws ItemError when a source returns junk. */
export function createItem(fields) {
  if (!fields || typeof fields !== 'object') throw new ItemError('item must be an object');
  const urgency = fields.urgency;
  if (!URGENCIES.includes(urgency)) {
    throw new ItemError(`item.urgency must be one of ${URGENCIES.join(', ')} (got ${JSON.stringify(urgency)})`);
  }
  let url = fields.url ?? null;
  if (url !== null) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new ItemError(`item.url must be an http(s) URL or null (got ${JSON.stringify(url)})`);
    }
  }
  const when = new Date(fields.updatedAt ?? Date.now());
  if (Number.isNaN(when.getTime())) throw new ItemError(`item.updatedAt is not a valid date`);
  const meta = fields.meta ?? {};
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new ItemError('item.meta must be an object');

  return {
    id: req(fields, 'id', 'string'),
    source: req(fields, 'source', 'string'),
    kind: req(fields, 'kind', 'string'),
    title: req(fields, 'title', 'string'),
    url,
    why: req(fields, 'why', 'string'),
    urgency,
    updatedAt: when.toISOString(),
    meta,
  };
}

/** What "done" and "until it changes" compare against. */
export function fingerprint(item) {
  return String(item.meta?.fingerprint ?? `${item.title}\n${item.urgency}`);
}

const URGENCY_ORDER = Object.fromEntries(URGENCIES.map((u, i) => [u, i]));

/**
 * Sort order, in plain words:
 *   1. Now before Today before Later.
 *   2. Within a group, the rule listed first in rules.mjs wins (it is the more pressing one).
 *   3. Then the oldest first: work that has been waiting longest is the most at risk.
 */
export function compareItems(a, b) {
  return (URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])
    || ((a.meta?.rule?.order ?? 999) - (b.meta?.rule?.order ?? 999))
    || (Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    || a.id.localeCompare(b.id);
}

export function sortItems(items) {
  return [...items].sort(compareItems);
}
