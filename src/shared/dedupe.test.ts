import { describe, expect, it } from 'vitest';
import { planMerges, type DedupeGroup } from './dedupe';

let nextTab = 1;
const g = (id: number, windowId: number, title: string, urls: string[], index = id): DedupeGroup => ({
  id,
  windowId,
  title,
  index,
  tabs: urls.map((url) => ({ id: nextTab++, url })),
});
const tabIds = (group: DedupeGroup, ...urls: string[]) => group.tabs.filter((t) => urls.includes(t.url)).map((t) => t.id);

const A = 'https://a.dev/';
const B = 'https://b.dev/';
const C = 'https://c.dev/';

describe('planMerges', () => {
  it('merges same-named groups inside a window into the first in strip order', () => {
    const first = g(1, 1, 'api', [A], 0);
    const dup = g(2, 1, 'API', [A, B], 5);
    expect(planMerges([dup, first], { kind: 'window', windowId: 1 })).toEqual([
      { from: 2, fromWindowId: 1, into: 1, intoWindowId: 1, move: tabIds(dup, B), close: tabIds(dup, A) },
    ]);
  });

  it('ignores untitled groups and other windows in window scope', () => {
    const groups = [g(1, 1, '', [A]), g(2, 1, '', [A]), g(3, 2, 'api', [A]), g(4, 1, 'api', [B])];
    expect(planMerges(groups, { kind: 'window', windowId: 1 })).toEqual([]);
  });

  it('pull: brings same-named groups of other windows into the current window', () => {
    const here = g(1, 1, 'api', [A]);
    const there = g(2, 2, 'api', [A, C]);
    const unrelated = g(3, 2, 'docs', [B]);
    expect(planMerges([here, there, unrelated], { kind: 'pull', windowId: 1 })).toEqual([
      { from: 2, fromWindowId: 2, into: 1, intoWindowId: 1, move: tabIds(there, C), close: tabIds(there, A) },
    ]);
  });

  it('pull: never merges Inbox across windows', () => {
    const groups = [g(1, 1, 'Inbox', [A]), g(2, 2, 'Inbox', [A])];
    expect(planMerges(groups, { kind: 'pull', windowId: 1 })).toEqual([]);
  });

  it('pull: a URL moved in from one duplicate is not moved again from the next', () => {
    const here = g(1, 1, 'api', [A]);
    const d1 = g(2, 2, 'api', [C]);
    const d2 = g(3, 3, 'api', [C]);
    const merges = planMerges([here, d1, d2], { kind: 'pull', windowId: 1 });
    expect(merges.map((m) => [m.move.length, m.close.length])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('push: merges a restored copy into the original window when the URLs mostly match', () => {
    const original = g(1, 1, 'api', [A, B]);
    const copy = g(2, 2, 'api', [A, B, C]);
    expect(planMerges([original, copy], { kind: 'push', windowId: 2 })).toEqual([
      { from: 2, fromWindowId: 2, into: 1, intoWindowId: 1, move: tabIds(copy, C), close: tabIds(copy, A, B) },
    ]);
  });

  it('push: leaves a same-named group with different content alone', () => {
    const original = g(1, 1, 'api', [A]);
    const other = g(2, 2, 'api', [B, C]);
    expect(planMerges([original, other], { kind: 'push', windowId: 2 })).toEqual([]);
  });

  it('push: carries tabs merged locally first along to the other window', () => {
    const original = g(1, 1, 'api', [A, B]);
    const copy = g(2, 2, 'api', [A, B], 0);
    const copy2 = g(3, 2, 'api', [C], 4);
    const merges = planMerges([original, copy, copy2], { kind: 'push', windowId: 2 });
    expect(merges).toHaveLength(2);
    expect(merges[0]).toMatchObject({ from: 3, into: 2, move: tabIds(copy2, C) });
    expect(merges[1]).toMatchObject({ from: 2, into: 1, move: tabIds(copy2, C), close: tabIds(copy, A, B) });
  });
});
