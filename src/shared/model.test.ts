import { describe, expect, it } from 'vitest';
import { NO_GROUP, cycle, decidePlacement, groupOrder, mruFromTabs, pickTabToActivate, touchMru, type TabLike } from './model';

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

describe('mruFromTabs', () => {
  it('orders groups by their most recently accessed tab', () => {
    const tabs = [
      tab(0, 1, { lastAccessed: 10 }),
      tab(1, 1, { lastAccessed: 50 }),
      tab(2, 2, { lastAccessed: 40 }),
      tab(3, NO_GROUP, { lastAccessed: 99 }),
      tab(4, 3, { lastAccessed: 45 }),
    ];
    expect(mruFromTabs(tabs)).toEqual([1, 3, 2]);
  });
});

describe('decidePlacement', () => {
  it('puts a new tab with a grouped opener into the opener group', () => {
    expect(decidePlacement({ isNew: true, external: false, openerGroupId: 4, activeGroupId: 7 })).toEqual({
      kind: 'group',
      groupId: 4,
    });
  });

  it('puts a new tab with an ungrouped opener (e.g. Ctrl+T from a pinned tab) into the active group', () => {
    expect(decidePlacement({ isNew: true, external: false, openerGroupId: NO_GROUP, activeGroupId: 7 })).toEqual({
      kind: 'group',
      groupId: 7,
    });
  });

  it('sends a new tab to Inbox when there is no group to join', () => {
    expect(decidePlacement({ isNew: true, external: false })).toEqual({ kind: 'inbox' });
  });

  it('sends external-app tabs to Inbox even though Chrome gives them an opener', () => {
    expect(decidePlacement({ isNew: true, external: true, openerGroupId: 4, activeGroupId: 7 })).toEqual({
      kind: 'inbox',
    });
  });

  it('sends existing strays to Inbox', () => {
    expect(decidePlacement({ isNew: false, external: false, openerGroupId: 4, activeGroupId: 7 })).toEqual({
      kind: 'inbox',
    });
  });
});
