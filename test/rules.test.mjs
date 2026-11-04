import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ago, rank, RULES, until } from '../src/rules.mjs';

describe('rank', () => {
  it('unpushed commits escalate with age', () => {
    assert.equal(rank('unpushed', { count: 2, ageDays: 0.2, hasUpstream: true }).urgency, 'later');
    assert.equal(rank('unpushed', { count: 2, ageDays: 1.5, hasUpstream: true }).urgency, 'today');
    const r = rank('unpushed', { count: 3, ageDays: 5, hasUpstream: false });
    assert.equal(r.urgency, 'now');
    assert.equal(r.rule.id, 'unpushed-old');
    assert.match(r.why, /\*\*3 commits\*\* only on this machine for \*\*5 days\*\*/);
  });

  it('uncommitted edits become today after 3 days, untracked-only stays later', () => {
    assert.equal(rank('uncommitted', { tracked: 4, untracked: 0, ageDays: 0.5 }).urgency, 'later');
    assert.equal(rank('uncommitted', { tracked: 4, untracked: 0, ageDays: 3 }).urgency, 'today');
    const r = rank('uncommitted', { tracked: 0, untracked: 2, ageDays: 30 });
    assert.equal(r.rule.id, 'untracked');
    assert.equal(r.urgency, 'later');
  });

  it('branch cleanup is always later', () => {
    assert.equal(rank('merged-branches', { count: 2, base: 'main' }).urgency, 'later');
    assert.match(rank('stale-branches', { count: 1, gone: 1, oldestDays: 2 }).why, /Remote branch deleted/);
    assert.match(rank('stale-branches', { count: 2, gone: 0, oldestDays: 90 }).why, /3 months/);
  });

  it('every rule explains itself and earlier rules sort first', () => {
    for (const r of RULES) assert.ok(r.text.includes('→'), `${r.id} needs a readable text`);
    const a = rank('unpushed', { count: 1, ageDays: 9, hasUpstream: true });
    const b = rank('unpushed', { count: 1, ageDays: 0, hasUpstream: true });
    assert.ok(a.rule.order < b.rule.order);
  });

  it('review requests: waiting a day is Now, fresh is Today, team or draft is Later', () => {
    const base = { requester: 'ana', team: null, draft: false };
    assert.equal(rank('review-request', { ...base, ageDays: 2 }).why, '**@ana** requested your review **2 days** ago · they are waiting on you');
    assert.equal(rank('review-request', { ...base, ageDays: 0.2 }).urgency, 'today');
    assert.equal(rank('review-request', { ...base, team: '@acme/web', ageDays: 9 }).urgency, 'later');
    assert.equal(rank('review-request', { ...base, draft: true, ageDays: 9 }).urgency, 'later');
  });

  it('people waiting on you sort before deadlines, and both before local git hygiene', () => {
    const order = (kind, s) => rank(kind, s).rule.order;
    const review = order('review-request', { requester: 'a', draft: false, team: null, ageDays: 3 });
    const overdue = order('ticket', { dueDays: -1, sprintDays: null, status: 'To Do', blockedBy: [] });
    const unpushed = order('unpushed', { count: 1, ageDays: 9, hasUpstream: true });
    assert.ok(review < overdue && overdue < unpushed);
  });

  it('jira tickets: blocked beats due soon, and everything else is Later', () => {
    const base = { status: 'In Progress', priority: 'Medium', dueDays: null, sprint: null, sprintDays: null, blockedBy: [], flagged: false, blockedStatus: false, ageDays: 1 };
    assert.equal(rank('ticket', { ...base, blockedBy: ['B-1'], dueDays: 2 }).rule.id, 'jira-blocked');
    assert.equal(rank('ticket', { ...base, priority: 'High' }).why, '**High** priority · In Progress');
    assert.equal(rank('ticket', base).urgency, 'later');
  });

  it('throws for unknown kinds', () => {
    assert.throws(() => rank('mystery', {}), /no ranking rule/);
  });
});

describe('until', () => {
  it('reads deadlines naturally', () => {
    assert.equal(until(-2.5), '2 days ago');
    assert.equal(until(0.3), 'today');
    assert.equal(until(1.5), 'tomorrow');
    assert.equal(until(4.2), 'in 4 days');
  });
});

describe('ago', () => {
  it('reads like a person wrote it', () => {
    assert.equal(ago(0.01), 'a few minutes');
    assert.equal(ago(0.5), '12 hours');
    assert.equal(ago(1), '1 day');
    assert.equal(ago(20), '2 weeks');
    assert.equal(ago(95), '3 months');
  });
});
