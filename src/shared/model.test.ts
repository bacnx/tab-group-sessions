import { describe, expect, it } from 'vitest';
import { NO_GROUP, cycle, decidePlacement, isExternalTransition, isNewTabPageUrl, groupOrder, isTitleTaken, moveGroupIndex, mruFromTabs, nthItem, numberGroups, titleError, pickTabToActivate, pushClosed, touchMru, type TabLike } from './model';

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

describe('nthItem', () => {
  it('is 1-based with 9 meaning last', () => {
    expect(nthItem(['a', 'b', 'c'], 1)).toBe('a');
    expect(nthItem(['a', 'b', 'c'], 3)).toBe('c');
    expect(nthItem(['a', 'b', 'c'], 4)).toBeUndefined();
    expect(nthItem(['a', 'b', 'c'], 9)).toBe('c');
    expect(nthItem([], 9)).toBeUndefined();
  });
});

describe('numberGroups', () => {
  it('numbers the Inbox 0 and the others 1–9 from the left', () => {
    const groups = [{ id: 1, title: 'api' }, { id: 2, title: 'Inbox' }, { id: 3 }, { id: 4, title: 'docs' }];
    expect([...numberGroups(groups)]).toEqual([[1, 1], [2, 0], [3, 2], [4, 3]]);
  });

  it('stops at 9 and numbers only the first Inbox', () => {
    const groups = Array.from({ length: 11 }, (_, i) => ({ id: i, title: `g${i}` }));
    groups.push({ id: 20, title: 'Inbox' }, { id: 21, title: 'Inbox' });
    const numbers = numberGroups(groups);
    expect(numbers.get(8)).toBe(9);
    expect(numbers.has(9)).toBe(false);
    expect(numbers.get(20)).toBe(0);
    expect(numbers.has(21)).toBe(false);
  });
});

describe('titles', () => {
  const groups = [
    { id: 1, title: 'API' },
    { id: 2, title: ' research  notes ' },
  ];

  it('detects duplicates case- and whitespace-insensitively', () => {
    expect(isTitleTaken(groups, 'api')).toBe(true);
    expect(isTitleTaken(groups, 'research notes')).toBe(true);
    expect(isTitleTaken(groups, 'api', 1)).toBe(false);
    expect(isTitleTaken(groups, 'labs')).toBe(false);
  });

  it('reports empty and duplicate names', () => {
    expect(titleError(groups, '   ')).toMatch(/empty/);
    expect(titleError(groups, 'Api')).toMatch(/already exists/);
    expect(titleError(groups, 'labs')).toBeUndefined();
  });
});

describe('moveGroupIndex', () => {
  // pinned(0) | A(1,2) | B(3) | C(4,5,6) | Inbox(7)
  const tabs = [
    tab(0, NO_GROUP, { pinned: true }),
    tab(1, 1),
    tab(2, 1),
    tab(3, 2),
    tab(4, 3),
    tab(5, 3),
    tab(6, 3),
    tab(7, 9),
  ];

  it('moves left onto the previous group start', () => {
    expect(moveGroupIndex(tabs, 2, -1, 9)).toBe(1);
    expect(moveGroupIndex(tabs, 1, -1, 9)).toBeUndefined();
  });

  it('moves right past the next group', () => {
    expect(moveGroupIndex(tabs, 1, 1, 9)).toBe(2); // A after B: B(1) A(2,3)
    expect(moveGroupIndex(tabs, 2, 1, 9)).toBe(6); // B after C: C(3,4,5) B(6)
  });

  it('never moves past or moves the pinned-last group', () => {
    expect(moveGroupIndex(tabs, 3, 1, 9)).toBeUndefined();
    expect(moveGroupIndex(tabs, 9, -1, 9)).toBeUndefined();
  });
});

describe('isExternalTransition', () => {
  it('only start_page (URL handed over by another app) is external', () => {
    expect(isExternalTransition('start_page')).toBe(true);
    for (const t of ['link', 'typed', 'auto_bookmark', 'reload', 'generated', 'form_submit']) {
      expect(isExternalTransition(t)).toBe(false);
    }
  });
});

describe('isNewTabPageUrl', () => {
  it('recognises the New Tab page only', () => {
    expect(isNewTabPageUrl('chrome://newtab/')).toBe(true);
    expect(isNewTabPageUrl('chrome://new-tab-page/')).toBe(true);
    expect(isNewTabPageUrl('https://teams.microsoft.com/')).toBe(false);
    expect(isNewTabPageUrl(undefined)).toBe(false);
  });
});

describe('pushClosed', () => {
  it('keeps the most recent first and caps the stack', () => {
    let stack: number[] = [];
    for (const n of [1, 2, 3, 4]) stack = pushClosed(stack, n, 3);
    expect(stack).toEqual([4, 3, 2]);
  });
});
