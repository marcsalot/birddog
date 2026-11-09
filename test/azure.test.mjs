// Unit tests for the new MY-PR signals in src/sources/azure.mjs:
//   • isBehind()     — branch-comparison logic
//   • isReplyOwed()  — thread filtering
//   • collect()      — integration via fake HTTP
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as azure from '../src/sources/azure.mjs';
import { fakeFetch } from './helpers.mjs';

const NOW = Date.parse('2026-11-04T16:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();

// ---------------------------------------------------------------------------
// Pure function: isBehind
// ---------------------------------------------------------------------------
describe('isBehind', () => {
  const pr = (sha) => ({ lastMergeTargetCommit: { commitId: sha } });

  it('returns false when target tip is null/missing', () => {
    assert.equal(azure.isBehind(pr('abc'), null), false);
    assert.equal(azure.isBehind(pr('abc'), undefined), false);
    assert.equal(azure.isBehind({}, 'abc'), false);
  });

  it('returns false when SHAs match (up-to-date)', () => {
    assert.equal(azure.isBehind(pr('deadbeef'), 'deadbeef'), false);
  });

  it('returns true when target tip moved ahead of PR merge base', () => {
    assert.equal(azure.isBehind(pr('oldsha'), 'newsha'), true);
  });
});

// ---------------------------------------------------------------------------
// Pure function: isReplyOwed
// ---------------------------------------------------------------------------
describe('isReplyOwed', () => {
  const MY_ID = 'user-me';
  const THEIR_ID = 'user-them';

  const thread = (overrides) => ({
    status: 'active',
    comments: [
      { commentType: 'text', author: { id: THEIR_ID, displayName: 'Them' }, content: 'Please fix this' },
    ],
    ...overrides,
  });

  it('returns true for active thread where last comment is not mine', () => {
    assert.equal(azure.isReplyOwed(thread(), MY_ID), true);
  });

  it('returns false when last comment is mine', () => {
    const t = thread({ comments: [
      { commentType: 'text', author: { id: THEIR_ID }, content: 'Fix this' },
      { commentType: 'text', author: { id: MY_ID }, content: 'Done' },
    ] });
    assert.equal(azure.isReplyOwed(t, MY_ID), false);
  });

  it('returns false for resolved thread', () => {
    assert.equal(azure.isReplyOwed(thread({ status: 'fixed' }), MY_ID), false);
  });

  it('returns false for thread with only system comments', () => {
    const t = thread({ comments: [
      { commentType: 'system', author: { id: THEIR_ID }, content: 'Vote cast: Approved' },
    ] });
    assert.equal(azure.isReplyOwed(t, MY_ID), false);
  });

  it('returns false for thread with no comments', () => {
    assert.equal(azure.isReplyOwed(thread({ comments: [] }), MY_ID), false);
  });

  it('ignores system comments when deciding last author', () => {
    // Human comment by them followed by a system comment — the last *human* comment
    // is theirs, so a reply is owed.
    const t = thread({ comments: [
      { commentType: 'text', author: { id: MY_ID }, content: 'Working on it' },
      { commentType: 'text', author: { id: THEIR_ID }, content: 'Please hurry' },
      { commentType: 'system', author: { id: THEIR_ID }, content: 'Vote cast' },
    ] });
    // isReplyOwed checks comments filtered to non-system; last is THEIR_ID.
    assert.equal(azure.isReplyOwed(t, MY_ID), true);
  });
});

// ---------------------------------------------------------------------------
// collect() integration: my-PR signals via fake ADO HTTP
// ---------------------------------------------------------------------------

const ORG = 'contoso';
const PROJ = 'Payments';
const ME_ID = 'me-uid';
const THEM_ID = 'them-uid';

// A minimal fake PR authored by me.
function myPr(overrides = {}) {
  return {
    pullRequestId: 10,
    title: 'My Feature',
    createdBy: { id: ME_ID, displayName: 'Me', uniqueName: 'me@contoso.com' },
    creationDate: ago(24),
    updatedDate: ago(1),
    isDraft: false,
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeTargetCommit: { commitId: 'base-sha' },
    reviewers: [],
    repository: { name: 'api', webUrl: 'https://dev.azure.com/contoso/Payments/_git/api' },
    ...overrides,
  };
}

// A minimal thread with a text comment from someone else.
function theirThread(overrides = {}) {
  return {
    id: 1,
    status: 'active',
    publishedDate: ago(2),
    lastUpdatedDate: ago(1),
    comments: [
      { commentType: 'text', author: { id: THEM_ID, displayName: 'Them' }, content: 'Review comment' },
    ],
    ...overrides,
  };
}

function fakeAdo({ myPrs = [], threads = {}, branchTip = 'base-sha' } = {}) {
  return fakeFetch((u) => {
    const p = u.pathname;
    // connectionData — who am I
    if (p.endsWith('/_apis/connectionData')) {
      return { body: { authenticatedUser: { id: ME_ID, providerDisplayName: 'Me' } } };
    }
    // reviewer-based PR list (existing path) — empty for these tests
    if (p.includes('/_apis/git/pullrequests') && u.searchParams.get('searchCriteria.reviewerId')) {
      return { body: { value: [] } };
    }
    // creator-based PR list (new path)
    if (p.includes('/_apis/git/pullrequests') && u.searchParams.get('searchCriteria.creatorId')) {
      return { body: { value: myPrs } };
    }
    // Thread fetch: /_apis/git/repositories/{repo}/pullRequests/{id}/threads
    const threadMatch = /\/pullRequests\/(\d+)\/threads/.exec(p);
    if (threadMatch) {
      const prId = Number(threadMatch[1]);
      return { body: { value: threads[prId] ?? [] } };
    }
    // Branch stats
    if (p.includes('/stats/branches')) {
      return { body: { commit: { commitId: branchTip } } };
    }
    // WIQL + work items — empty for these tests
    if (p.endsWith('/wiql')) return { body: { workItems: [] } };
    return undefined;
  });
}

const ctx = (fetch) => ({
  now: NOW, fetch, secret: async () => 'pat', warn() {}, summary() {},
});
const config = { organization: ORG, project: PROJ };
const byKind = (items) => Object.groupBy
  ? Object.groupBy(items, (i) => i.kind)
  : items.reduce((a, i) => ((a[i.kind] ??= []).push(i), a), {});

describe('azure collect() — rebase-request signal', () => {
  it('emits rebase-request when PR has merge conflicts', async () => {
    const pr = myPr({ mergeStatus: 'conflicts' });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.equal(k['rebase-request']?.length, 1);
    assert.match(k['rebase-request'][0].why, /Merge conflicts/);
    assert.equal(k['rebase-request'][0].urgency, 'today');
  });

  it('emits rebase-request (behind, later urgency) when target branch moved', async () => {
    const pr = myPr({ mergeStatus: 'succeeded', lastMergeTargetCommit: { commitId: 'old-sha' } });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'new-sha' });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.equal(k['rebase-request']?.length, 1);
    assert.match(k['rebase-request'][0].why, /behind/i);
    assert.equal(k['rebase-request'][0].urgency, 'later');
  });

  it('does not emit rebase-request when PR is up-to-date', async () => {
    const pr = myPr({ mergeStatus: 'succeeded' });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.ok(!byKind(items)['rebase-request']);
  });

  it('item id includes target tip SHA so it auto-refreshes when main moves', async () => {
    const pr = myPr({ mergeStatus: 'conflicts' });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'tip-123' });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.match(k['rebase-request'][0].id, /tip-123/);
  });

  it('skips draft PRs for rebase-request', async () => {
    const pr = myPr({ isDraft: true, mergeStatus: 'conflicts' });
    const f = fakeAdo({ myPrs: [pr] });
    const items = await azure.collect(config, ctx(f));
    // draft PRs still get reply-owed checked but not rebase-request
    assert.ok(!byKind(items)['rebase-request']);
  });
});

describe('azure collect() — reply-owed signal', () => {
  it('emits reply-owed when reviewer spoke last', async () => {
    const pr = myPr();
    const f = fakeAdo({ myPrs: [pr], threads: { 10: [theirThread()] }, branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.equal(k['reply-owed']?.length, 1);
    assert.match(k['reply-owed'][0].why, /thread/i);
    assert.equal(k['reply-owed'][0].meta.fields['Open threads'], '1');
  });

  it('does not emit reply-owed when I spoke last', async () => {
    const pr = myPr();
    const myThread = theirThread({ comments: [
      { commentType: 'text', author: { id: THEM_ID }, content: 'Fix this' },
      { commentType: 'text', author: { id: ME_ID }, content: 'Fixed' },
    ] });
    const f = fakeAdo({ myPrs: [pr], threads: { 10: [myThread] }, branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.ok(!byKind(items)['reply-owed']);
  });

  it('does not emit reply-owed for resolved threads', async () => {
    const pr = myPr();
    const resolved = theirThread({ status: 'fixed' });
    const f = fakeAdo({ myPrs: [pr], threads: { 10: [resolved] }, branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.ok(!byKind(items)['reply-owed']);
  });

  it('counts multiple owed threads correctly', async () => {
    const pr = myPr();
    const f = fakeAdo({
      myPrs: [pr],
      threads: { 10: [theirThread({ id: 1 }), theirThread({ id: 2 })] },
      branchTip: 'base-sha',
    });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.equal(k['reply-owed'][0].meta.fields['Open threads'], '2');
    assert.match(k['reply-owed'][0].why, /2 open threads/i);
  });

  it('applies to draft PRs too', async () => {
    const pr = myPr({ isDraft: true });
    const f = fakeAdo({ myPrs: [pr], threads: { 10: [theirThread()] }, branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.equal(byKind(items)['reply-owed']?.length, 1);
  });
});

describe('azure collect() — pr-ready signal', () => {
  it('emits pr-ready when mergeStatus=succeeded and required reviewers approved', async () => {
    const pr = myPr({
      reviewers: [{ id: THEM_ID, vote: 10, isRequired: true, displayName: 'Them' }],
    });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.equal(k['pr-ready']?.length, 1);
    assert.match(k['pr-ready'][0].why, /Ready to merge/);
    assert.equal(k['pr-ready'][0].urgency, 'today');
  });

  it('does not emit pr-ready when a required reviewer has not voted', async () => {
    const pr = myPr({
      reviewers: [
        { id: THEM_ID, vote: 10, isRequired: true },
        { id: 'other', vote: 0, isRequired: true },
      ],
    });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.ok(!byKind(items)['pr-ready']);
  });

  it('does not emit pr-ready when there are no required reviewers', async () => {
    const pr = myPr({ reviewers: [] });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.ok(!byKind(items)['pr-ready']);
  });

  it('does not emit pr-ready when mergeStatus is not succeeded', async () => {
    const pr = myPr({
      mergeStatus: 'conflicts',
      reviewers: [{ id: THEM_ID, vote: 10, isRequired: true }],
    });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    assert.ok(!byKind(items)['pr-ready']);
  });

  it('does not emit pr-ready when there are owed reply threads', async () => {
    const pr = myPr({
      reviewers: [{ id: THEM_ID, vote: 10, isRequired: true }],
    });
    const f = fakeAdo({
      myPrs: [pr],
      threads: { 10: [theirThread()] },
      branchTip: 'base-sha',
    });
    const items = await azure.collect(config, ctx(f));
    // Should have reply-owed but not pr-ready
    assert.ok(!byKind(items)['pr-ready']);
    assert.equal(byKind(items)['reply-owed']?.length, 1);
  });

  it('fingerprint encodes mergeStatus and approver votes', async () => {
    const pr = myPr({
      reviewers: [{ id: THEM_ID, vote: 10, isRequired: true }],
    });
    const f = fakeAdo({ myPrs: [pr], branchTip: 'base-sha' });
    const items = await azure.collect(config, ctx(f));
    const k = byKind(items);
    assert.match(k['pr-ready'][0].meta.fingerprint, /succeeded/);
    assert.match(k['pr-ready'][0].meta.fingerprint, /10/);
  });
});
