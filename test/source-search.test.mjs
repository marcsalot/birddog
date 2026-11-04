// Sources & settings search: names, kinds and keywords.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sourceMatches } from '../public/js/source-search.js';
import { SOURCES } from '../src/sources/index.mjs';

const find = (q) => SOURCES.filter((s) => sourceMatches(s, q)).map((s) => s.id).sort();

describe('source search', () => {
  it('empty matches everything', () => assert.equal(find('  ').length, SOURCES.length));
  it('finds by name, case-insensitively', () => assert.deepEqual(find('SLACK'), ['slack']));
  it('"calendar" finds the calendar source (Google, Microsoft, iCloud, iCal)', () => {
    assert.ok(find('calendar').includes('cal'));
    for (const q of ['google', 'microsoft', 'icloud', 'ical']) assert.ok(find(q).includes('cal'), q);
  });
  it('"ci" finds GitHub Actions, GitLab pipelines and Azure', () => {
    const hits = find('ci');
    for (const id of ['github', 'gitlab', 'azure']) assert.ok(hits.includes(id), id);
  });
  it('every word must match', () => assert.deepEqual(find('tickets sprints'), ['jira']));
  it('matches word starts only', () => assert.ok(!find('ci').includes('pagerduty'), '"ci" is not in "incidents"'));
  it('no match', () => assert.deepEqual(find('zzzz'), []));
});
