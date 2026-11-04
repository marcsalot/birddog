import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createItem, fingerprint, ItemError, sortItems } from '../src/items.mjs';
import { fakeItem } from './helpers.mjs';

describe('createItem', () => {
  it('normalizes a valid item', () => {
    const it = createItem(fakeItem({ updatedAt: 0, url: 'https://example.com/x' }));
    assert.equal(it.updatedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(it.url, 'https://example.com/x');
    assert.deepEqual(it.meta, {});
  });

  it('defaults url to null and meta to {}', () => {
    const { url, meta, ...rest } = fakeItem();
    const it = createItem(rest);
    assert.equal(it.url, null);
    assert.deepEqual(it.meta, {});
  });

  it('drops unknown top-level fields', () => {
    assert.equal('extra' in createItem(fakeItem({ extra: 1 })), false);
  });

  for (const [field, value] of [
    ['urgency', 'soon'], ['id', ''], ['title', undefined], ['why', 42],
    ['url', 'javascript:alert(1)'], ['url', 'file:///etc/passwd'], ['updatedAt', 'not a date'], ['meta', []],
  ]) {
    it(`rejects ${field}=${JSON.stringify(value)}`, () => {
      assert.throws(() => createItem(fakeItem({ [field]: value })), ItemError);
    });
  }
});

describe('sortItems', () => {
  const at = (d) => new Date(Date.UTC(2026, 0, d)).toISOString();

  it('orders by urgency, then rule order, then oldest first', () => {
    const items = [
      fakeItem({ id: 'later', urgency: 'later', updatedAt: at(1) }),
      fakeItem({ id: 'today-new', urgency: 'today', updatedAt: at(9), meta: { rule: { order: 1 } } }),
      fakeItem({ id: 'today-old', urgency: 'today', updatedAt: at(2), meta: { rule: { order: 1 } } }),
      fakeItem({ id: 'today-rule0', urgency: 'today', updatedAt: at(9), meta: { rule: { order: 0 } } }),
      fakeItem({ id: 'now', urgency: 'now', updatedAt: at(5) }),
    ];
    assert.deepEqual(sortItems(items).map((i) => i.id), ['now', 'today-rule0', 'today-old', 'today-new', 'later']);
  });

  it('does not mutate its input', () => {
    const items = [fakeItem({ id: 'b', urgency: 'later' }), fakeItem({ id: 'a', urgency: 'now' })];
    sortItems(items);
    assert.equal(items[0].id, 'b');
  });
});

describe('fingerprint', () => {
  it('prefers meta.fingerprint', () => {
    assert.equal(fingerprint(fakeItem({ meta: { fingerprint: 'abc' } })), 'abc');
  });
  it('falls back to title and urgency', () => {
    assert.notEqual(fingerprint(fakeItem({ urgency: 'now' })), fingerprint(fakeItem({ urgency: 'later' })));
  });
});
