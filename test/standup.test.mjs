import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateStandup, lastWorkingDaySince } from '../src/standup.mjs';

// ---------------------------------------------------------------------------
// Helpers

/** Build a minimal item. The id field in `over` is a short key; the actual item.id becomes `item:{key}`. */
function item(over = {}) {
  const { id: rawId = '1', ...rest } = over;
  return {
    source: 'github',
    kind: 'my-pr',
    title: 'PR owner/repo #1',
    url: null,
    why: 'Because **reasons**',
    urgency: 'today',
    updatedAt: new Date(0).toISOString(),
    meta: {},
    ...rest,
    id: `item:${rawId}`,  // always last so ...rest cannot override it
  };
}

/** Shorthand: build an ack key for the given short id. */
const ackKey = (rawId) => `item:${rawId}`;

/** Build an acks Map from an array of [id, entry] pairs. */
function acks(...entries) {
  return new Map(entries);
}

/** Fake snapshot with the given items array. */
const snap = (items) => ({ items, sources: [], refreshedAt: new Date(0).toISOString() });

// ---------------------------------------------------------------------------
// lastWorkingDaySince

describe('lastWorkingDaySince', () => {
  // Monday 2026-11-09 12:00 UTC  → day=1
  const monday = Date.UTC(2026, 10, 9, 12, 0, 0);
  // Tuesday 2026-11-10 09:00 UTC → day=2
  const tuesday = Date.UTC(2026, 10, 10, 9, 0, 0);
  // Saturday 2026-11-14 09:00 UTC → day=6
  const saturday = Date.UTC(2026, 10, 14, 9, 0, 0);

  it('returns last Monday midnight when today is Monday', () => {
    const result = lastWorkingDaySince(monday);
    // Start of today (Mon Nov 9) - 7 days = Mon Nov 2 00:00 UTC
    const expected = Date.UTC(2026, 10, 2, 0, 0, 0);
    assert.equal(result, expected);
  });

  it('returns yesterday midnight for a Tuesday', () => {
    const result = lastWorkingDaySince(tuesday);
    // Yesterday = Mon Nov 9 00:00 UTC
    const expected = Date.UTC(2026, 10, 9, 0, 0, 0);
    assert.equal(result, expected);
  });

  it('returns yesterday midnight for a Saturday', () => {
    const result = lastWorkingDaySince(saturday);
    // Yesterday = Fri Nov 13 00:00 UTC
    const expected = Date.UTC(2026, 10, 13, 0, 0, 0);
    assert.equal(result, expected);
  });

  it('returns a value that is a Date at midnight UTC', () => {
    const result = lastWorkingDaySince(tuesday);
    const d = new Date(result);
    assert.equal(d.getUTCHours(), 0);
    assert.equal(d.getUTCMinutes(), 0);
    assert.equal(d.getUTCSeconds(), 0);
  });
});

// ---------------------------------------------------------------------------
// generateStandup — basic structure

describe('generateStandup structure', () => {
  it('returns three section headers', () => {
    const text = generateStandup(snap([]), new Map(), { now: Date.UTC(2026, 10, 10, 9) });
    assert.ok(text.includes('Yesterday / Today'));
    assert.ok(text.includes('In progress'));
    assert.ok(text.includes('Blockers'));
  });

  it('shows empty-state lines when nothing is active', () => {
    const text = generateStandup(snap([]), new Map(), { now: Date.UTC(2026, 10, 10, 9) });
    assert.ok(text.includes('(nothing marked done)'));
    assert.ok(text.includes('(nothing active)'));
    assert.ok(text.includes('(none)'));
  });
});

// ---------------------------------------------------------------------------
// Done section

describe('generateStandup done section', () => {
  // Tuesday 2026-11-10 09:00 UTC — cutoff is yesterday midnight (Nov 9 00:00 UTC)
  const now = Date.UTC(2026, 10, 10, 9, 0, 0);
  const cutoff = Date.UTC(2026, 10, 9, 0, 0, 0); // yesterday

  it('includes items done after the cutoff', () => {
    const it1 = item({ id: '1', title: 'Fix login bug' });
    const doneAt = cutoff + 3_600_000; // 1 hour after cutoff
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'done', doneAt }]),
      { now },
    );
    assert.ok(text.includes('Fix login bug'), text);
    assert.ok(!text.includes('(nothing marked done)'));
  });

  it('excludes items done before the cutoff', () => {
    const it1 = item({ id: '1', title: 'Old task' });
    const doneAt = cutoff - 1; // 1 ms before cutoff
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'done', doneAt }]),
      { now },
    );
    assert.ok(!text.includes('Old task'), text);
    assert.ok(text.includes('(nothing marked done)'));
  });

  it('excludes items with null doneAt', () => {
    const it1 = item({ id: '1', title: 'Null timestamp' });
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'done', doneAt: null }]),
      { now },
    );
    assert.ok(!text.includes('Null timestamp'));
  });

  it('excludes snoozed items (not done)', () => {
    const it1 = item({ id: '1', title: 'Snoozed item' });
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'snoozed', doneAt: now }]),
      { now },
    );
    assert.ok(!text.includes('Snoozed item'));
  });

  it('sorts done items by source then title', () => {
    const a = item({ id: 'a', source: 'jira', title: 'B ticket' });
    const b = item({ id: 'b', source: 'github', title: 'A PR' });
    const c = item({ id: 'c', source: 'jira', title: 'A ticket' });
    const doneAt = cutoff + 1000;
    const text = generateStandup(
      snap([a, b, c]),
      acks(
        [ackKey('a'), { status: 'done', doneAt }],
        [ackKey('b'), { status: 'done', doneAt }],
        [ackKey('c'), { status: 'done', doneAt }],
      ),
      { now },
    );
    // github (A PR) comes before jira (A ticket, B ticket)
    const aIdx = text.indexOf('A PR');
    const bIdx = text.indexOf('A ticket');
    const cIdx = text.indexOf('B ticket');
    assert.ok(aIdx < bIdx, 'github before jira');
    assert.ok(bIdx < cIdx, 'A ticket before B ticket within jira');
  });

  it('Monday cutoff includes items done since previous Monday', () => {
    const monday = Date.UTC(2026, 10, 9, 10, 0, 0); // Nov 9 = Monday
    const prevMonday00 = Date.UTC(2026, 10, 2, 0, 0, 0); // Nov 2 00:00 UTC
    const it1 = item({ id: '1', title: 'Weekend work' });
    // Done on Saturday (Nov 7), which is after the Nov 2 cutoff
    const doneAt = Date.UTC(2026, 10, 7, 14, 0, 0);
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'done', doneAt }]),
      { now: monday },
    );
    assert.ok(text.includes('Weekend work'), text);
  });
});

// ---------------------------------------------------------------------------
// In progress section

describe('generateStandup in-progress section', () => {
  const now = Date.UTC(2026, 10, 10, 9, 0, 0);

  it('includes open items at urgency now and today', () => {
    const a = item({ id: 'a', urgency: 'now', title: 'Hot fix' });
    const b = item({ id: 'b', urgency: 'today', title: 'Normal task' });
    const c = item({ id: 'c', urgency: 'later', title: 'Later task' });
    const text = generateStandup(snap([a, b, c]), new Map(), { now });
    assert.ok(text.includes('Hot fix'), text);
    assert.ok(text.includes('Normal task'), text);
    assert.ok(!text.includes('Later task'), text);
  });

  it('excludes items marked done in acks', () => {
    const it1 = item({ id: '1', urgency: 'today', title: 'Done item' });
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'done', doneAt: now }]),
      { now },
    );
    // Should not appear in in-progress
    const inProgressIdx = text.indexOf('In progress');
    const blockersIdx = text.indexOf('Blockers');
    const doneItemIdx = text.indexOf('Done item');
    // Done item is in the done section (before in-progress) only if cutoff is right; here doneAt=now
    // which is after cutoff. But we're testing the in-progress filter specifically.
    // If done item appears, it should be in Done section, not in In progress.
    if (doneItemIdx !== -1) {
      // It may appear in Done section — that's fine — but NOT between in-progress and blockers headers
      assert.ok(doneItemIdx < inProgressIdx || doneItemIdx > blockersIdx, 'done item should not be in in-progress section');
    }
  });

  it('excludes jira-blocked tickets from in-progress', () => {
    const blocked = item({
      id: '1', urgency: 'today', kind: 'ticket', title: 'Blocked ticket',
      meta: { rule: { id: 'jira-blocked', text: 'blocked', order: 0 } },
    });
    const text = generateStandup(snap([blocked]), new Map(), { now });
    const inProgressIdx = text.indexOf('In progress');
    const blockersIdx = text.indexOf('Blockers');
    const titleIdx = text.indexOf('Blocked ticket');
    // Should not appear in in-progress section (between its header and Blockers)
    if (titleIdx !== -1) {
      assert.ok(!(titleIdx > inProgressIdx && titleIdx < blockersIdx), 'blocked ticket should not be in in-progress');
    }
  });

  it('limits to 10 items', () => {
    const items = Array.from({ length: 15 }, (_, i) => item({ id: String(i), urgency: 'today', title: `Task ${i}` }));
    const text = generateStandup(snap(items), new Map(), { now });
    const inProgressStart = text.indexOf('In progress');
    const blockersStart = text.indexOf('\nBlockers');
    const inProgressSection = text.slice(inProgressStart, blockersStart);
    const lineCount = inProgressSection.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.ok(lineCount <= 10, `Expected ≤10 lines, got ${lineCount}`);
  });

  it('strips ** from why text', () => {
    const it1 = item({ id: '1', urgency: 'today', title: 'Task', why: '**Bold** reason' });
    const text = generateStandup(snap([it1]), new Map(), { now });
    assert.ok(!text.includes('**'), 'No markdown bold markers in output');
    assert.ok(text.includes('Bold reason'), 'Why text content preserved');
  });

  it('uses middle dot separator between title and why', () => {
    const it1 = item({ id: '1', urgency: 'today', title: 'Task', why: 'Some reason' });
    const text = generateStandup(snap([it1]), new Map(), { now });
    assert.ok(text.includes('Task \u00b7 Some reason'), text);
  });
});

// ---------------------------------------------------------------------------
// Blockers section

describe('generateStandup blockers section', () => {
  const now = Date.UTC(2026, 10, 10, 9, 0, 0);

  it('includes jira-blocked items', () => {
    const it1 = item({
      id: '1', title: 'PROJ-456',
      meta: { rule: { id: 'jira-blocked', text: 'Blocked', order: 0 } },
    });
    const text = generateStandup(snap([it1]), new Map(), { now });
    const blockersStart = text.indexOf('Blockers');
    assert.ok(text.slice(blockersStart).includes('PROJ-456'), text);
  });

  it('includes rebase-conflicts items', () => {
    const it1 = item({
      id: '1', title: 'PR owner/repo #7',
      meta: { rule: { id: 'rebase-conflicts', text: 'conflicts', order: 0 } },
    });
    const text = generateStandup(snap([it1]), new Map(), { now });
    const blockersStart = text.indexOf('Blockers');
    assert.ok(text.slice(blockersStart).includes('PR owner/repo #7'), text);
  });

  it('includes unblock-done items', () => {
    const it1 = item({
      id: '1', title: 'PROJ-401 unblocked',
      meta: { rule: { id: 'unblock-done', text: 'unblocked', order: 0 } },
    });
    const text = generateStandup(snap([it1]), new Map(), { now });
    const blockersStart = text.indexOf('Blockers');
    assert.ok(text.slice(blockersStart).includes('PROJ-401 unblocked'), text);
  });

  it('excludes done blockers', () => {
    const it1 = item({
      id: '1', title: 'Resolved blocker',
      meta: { rule: { id: 'jira-blocked', text: 'blocked', order: 0 } },
    });
    const text = generateStandup(
      snap([it1]),
      acks([ackKey('1'), { status: 'done', doneAt: now }]),
      { now },
    );
    const blockersStart = text.indexOf('Blockers');
    assert.ok(!text.slice(blockersStart).includes('Resolved blocker'), text);
  });

  it('limits to 5 items', () => {
    const items = Array.from({ length: 8 }, (_, i) => item({
      id: String(i), title: `Blocker ${i}`,
      meta: { rule: { id: 'jira-blocked', text: 'blocked', order: 0 } },
    }));
    const text = generateStandup(snap(items), new Map(), { now });
    const blockersStart = text.indexOf('Blockers');
    const blockersSection = text.slice(blockersStart);
    const lineCount = blockersSection.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.ok(lineCount <= 5, `Expected ≤5 lines, got ${lineCount}`);
  });

  it('shows (none) when there are no blockers', () => {
    const it1 = item({ id: '1', urgency: 'today' });
    const text = generateStandup(snap([it1]), new Map(), { now });
    assert.ok(text.includes('(none)'));
  });
});

// ---------------------------------------------------------------------------
// Edge cases

describe('generateStandup edge cases', () => {
  const now = Date.UTC(2026, 10, 10, 9, 0, 0);

  it('handles empty snapshot gracefully', () => {
    assert.doesNotThrow(() => generateStandup({ items: [] }, new Map(), { now }));
  });

  it('handles null/undefined snapshot.items', () => {
    assert.doesNotThrow(() => generateStandup({ items: undefined }, new Map(), { now }));
    assert.doesNotThrow(() => generateStandup(null, new Map(), { now }));
  });

  it('handles acks with item not in snapshot', () => {
    // ack references an id not in snapshot — should be silently skipped
    const cutoff = lastWorkingDaySince(now);
    const text = generateStandup(
      snap([]),
      acks([ackKey('ghost'), { status: 'done', doneAt: cutoff + 1000 }]),
      { now },
    );
    assert.ok(text.includes('(nothing marked done)'));
  });

  it('defaults now to Date.now() when opts is omitted', () => {
    // Just check it does not throw
    assert.doesNotThrow(() => generateStandup(snap([]), new Map()));
  });
});
