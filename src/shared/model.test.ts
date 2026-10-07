import { describe, expect, it } from 'vitest';
import { NO_GROUP, cycle, groupOrder, pickTabToActivate, touchMru, type TabLike } from './model';

const tab = (index: number, groupId: number, extra: Partial<TabLike> = {}): TabLike => ({
  id: index + 100,
  index,
  groupId,
  pinned: false,
  ...extra,
});

describe('groupOrder', () => {
  it('lists distinct groups in strip order, skipping ungrouped tabs', () => {
    const tabs = [tab(3, 7), tab(0, NO_GROUP, { pinned: true }), tab(1, 5), tab(2, 5), tab(4, 7), tab(5, 9)];
    expect(groupOrder(tabs)).toEqual([5, 7, 9]);
  });

  it('is empty without groups', () => {
    expect(groupOrder([tab(0, NO_GROUP)])).toEqual([]);
  });
});

describe('cycle', () => {
  it('wraps forward and backward', () => {
    expect(cycle([1, 2, 3], 3, 1)).toBe(1);
    expect(cycle([1, 2, 3], 1, -1)).toBe(3);
    expect(cycle([1, 2, 3], 2, 1)).toBe(3);
  });

  it('starts from an edge when current is unknown', () => {
    expect(cycle([1, 2, 3], undefined, 1)).toBe(1);
    expect(cycle([1, 2, 3], 42, -1)).toBe(3);
  });

  it('handles empty and single-item lists', () => {
    expect(cycle([], 1, 1)).toBeUndefined();
    expect(cycle([4], 4, 1)).toBe(4);
  });
});

describe('touchMru', () => {
  it('moves the id to the front without duplicates', () => {
    expect(touchMru([1, 2, 3], 3)).toEqual([3, 1, 2]);
    expect(touchMru([], 5)).toEqual([5]);
  });

  it('caps the length', () => {
    expect(touchMru([1, 2, 3], 4, 3)).toEqual([4, 1, 2]);
  });
});

describe('pickTabToActivate', () => {
  it('prefers the most recently accessed tab', () => {
    const tabs = [tab(0, 1, { lastAccessed: 10 }), tab(1, 1, { lastAccessed: 30 }), tab(2, 1, { lastAccessed: 20 })];
    expect(pickTabToActivate(tabs)?.index).toBe(1);
  });

  it('falls back to the first tab when lastAccessed is missing', () => {
    expect(pickTabToActivate([tab(2, 1), tab(1, 1)])?.index).toBe(1);
  });

  it('returns undefined for no tabs', () => {
    expect(pickTabToActivate([])).toBeUndefined();
  });
});
