import { describe, expect, it } from 'vitest';
import { describePlan, formatPlan, normalizeUrl, planIsEmpty, reconcile, type LiveWindowState, type RestorePlan } from './reconcile';
import type { SnapGroup, SnapWindow } from './snapshot';

const tab = (url: string) => ({ url, title: url });
const group = (title: string, urls: string[], extra: Partial<SnapGroup> = {}): SnapGroup => ({
  title,
  color: 'blue',
  collapsed: true,
  tabs: urls.map(tab),
  ...extra,
});
const snapWindow = (groups: SnapGroup[], extra: Partial<SnapWindow> = {}): SnapWindow => ({
  focused: true,
  activeGroup: groups[0]?.title,
  pinned: [],
  groups,
  ungrouped: [],
  ...extra,
});
const liveWindow = (id: number, groups: [string, string[]][], otherUrls: string[] = []): LiveWindowState => ({
  id,
  groups: groups.map(([title, urls], i) => ({ id: id * 100 + i, title, urls })),
  otherUrls,
});

const A = 'https://a.dev/';
const B = 'https://b.dev/x';
const C = 'https://c.dev/';
const D = 'https://d.dev/';
const M = 'https://mail.example/';

const session = [
  snapWindow([group('api', [A, B]), group('research', [C]), group('Inbox', [D], { color: 'grey' })], {
    pinned: [tab(M)],
    activeGroup: 'research',
  }),
];

/** Applies a plan to a live state the way restore.ts would, for idempotency checks. */
function apply(live: LiveWindowState[], plan: RestorePlan): LiveWindowState[] {
  let nextId = 1000;
  const result = live.map((w) => ({ ...w, groups: w.groups.map((g) => ({ ...g, urls: [...g.urls] })), otherUrls: [...w.otherUrls] }));
  for (const wp of plan.windows) {
    let w = result.find((x) => x.id === wp.windowId);
    if (!w) {
      w = { id: nextId++, groups: [], otherUrls: [] };
      result.push(w);
    }
    w.otherUrls.push(...wp.pinned.map((t) => t.url));
    for (const add of wp.addToGroups) w.groups.find((g) => g.id === add.groupId)!.urls.push(...add.tabs.map((t) => t.url));
    for (const g of wp.createGroups) w.groups.push({ id: nextId++, title: g.title, urls: g.tabs.map((t) => t.url) });
  }
  return result;
}

describe('reconcile', () => {
  it('plans nothing when Chrome restored everything (only the focus target)', () => {
    const live = [liveWindow(1, [['api', [A, B]], ['research', [C]], ['Inbox', [D]]], [M, 'chrome://newtab/'])];
    const plan = reconcile(session, live);
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.windowId).toBe(1);
    expect(plan.windows[0]!.activeGroup).toBe('research');
  });

  it('restores everything into the empty window Chrome opened', () => {
    const live = [liveWindow(1, [], ['chrome://newtab/'])];
    const plan = reconcile(session, live);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.windowId).toBe(1);
    expect(plan.windows[0]!.createGroups.map((g) => g.title)).toEqual(['api', 'research', 'Inbox']);
    expect(plan.windows[0]!.pinned.map((t) => t.url)).toEqual([M]);
    expect(plan.tabCount).toBe(5);
    expect(plan.groupCount).toBe(3);
  });

  it('adds only what is missing after a partial restore', () => {
    const live = [liveWindow(1, [['api', [A]]], [M])];
    const plan = reconcile(session, live);
    const w = plan.windows[0]!;
    expect(w.addToGroups).toEqual([{ groupId: 100, title: 'api', tabs: [tab(B)] }]);
    expect(w.createGroups.map((g) => g.title)).toEqual(['research', 'Inbox']);
    expect(w.pinned).toEqual([]);
  });

  it('is idempotent: applying the plan then reconciling again plans nothing', () => {
    for (const live of [[liveWindow(1, [], [])], [liveWindow(1, [['api', [A]]], [])]]) {
      const after = apply(live, reconcile(session, live));
      expect(planIsEmpty(reconcile(session, after))).toBe(true);
    }
  });

  it('does not re-add a tab the user moved to another group', () => {
    const live = [liveWindow(1, [['api', [A]], ['research', [C, B]], ['Inbox', [D]]], [M])];
    expect(planIsEmpty(reconcile(session, live))).toBe(true);
  });

  it('matches group titles case-insensitively', () => {
    const live = [liveWindow(1, [['API', [A, B]], ['Research', [C]], ['inbox', [D]]], [M])];
    expect(planIsEmpty(reconcile(session, live))).toBe(true);
  });

  it('keeps duplicate URLs as a multiset', () => {
    const snap = [snapWindow([group('dup', [A, A])])];
    const plan = reconcile(snap, [liveWindow(1, [['dup', [A]]])]);
    expect(plan.windows[0]!.addToGroups[0]!.tabs).toEqual([tab(A)]);
  });

  it('matches untitled groups by content', () => {
    const snap = [snapWindow([group('', [A, B, C])])];
    const plan = reconcile(snap, [liveWindow(1, [['', [A, B]]])]);
    expect(plan.windows[0]!.addToGroups).toEqual([{ groupId: 100, title: '', tabs: [tab(C)] }]);
    expect(plan.windows[0]!.createGroups).toEqual([]);
  });

  it('folds stray ungrouped snapshot tabs into Inbox', () => {
    const snap = [snapWindow([group('api', [A])], { ungrouped: [tab(D)] })];
    const plan = reconcile(snap, [liveWindow(1, [['api', [A]]])]);
    expect(plan.windows[0]!.createGroups).toEqual([{ title: 'Inbox', color: 'grey', collapsed: true, tabs: [tab(D)] }]);
  });

  it('opens a new window for a snapshot window that matches nothing', () => {
    const snap = [snapWindow([group('api', [A])]), snapWindow([group('labs', [C])], { focused: false })];
    const live = [liveWindow(1, [['api', [A]]])];
    const plan = reconcile(snap, live);
    expect(plan.windows.map((w) => w.windowId)).toEqual([1, undefined]);
    expect(plan.windows[1]!.createGroups.map((g) => g.title)).toEqual(['labs']);
  });

  it('pairs windows by overlap, not by order', () => {
    const snap = [snapWindow([group('api', [A])]), snapWindow([group('labs', [C, D])])];
    const live = [liveWindow(7, [['labs', [C, D]]]), liveWindow(8, [['api', [A]]])];
    const plan = reconcile(snap, live);
    expect(plan.windows.map((w) => w.windowId)).toEqual([8, 7]);
    expect(planIsEmpty(plan)).toBe(true);
  });

  it('skips new windows whose tabs are already open in another window', () => {
    const snap = [snapWindow([group('api', [A])]), snapWindow([group('labs', [C])])];
    // The user dragged C into window 1, outside the "api" group.
    const plan = reconcile(snap, [liveWindow(1, [['api', [A]]], [C])]);
    expect(plan.windows.map((w) => w.windowId)).toEqual([1]);
    expect(planIsEmpty(plan)).toBe(true);
  });
});

describe('normalizeUrl', () => {
  it('canonicalises host case and default ports', () => {
    expect(normalizeUrl('HTTPS://A.dev:443/x')).toBe('https://a.dev/x');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('isNearEmpty', () => {
  it('is true only without groups and with at most two tabs', async () => {
    const { isNearEmpty } = await import('./live');
    expect(isNearEmpty([liveWindow(1, [], ['chrome://newtab/'])])).toBe(true);
    expect(isNearEmpty([liveWindow(1, [], [A, B])])).toBe(true);
    expect(isNearEmpty([liveWindow(1, [], [A, B, C])])).toBe(false);
    expect(isNearEmpty([liveWindow(1, [['x', []]], [])])).toBe(false);
  });
});

describe('describePlan', () => {
  it('lists every missing tab by group, marking new groups and windows', () => {
    // api lost B, research and pinned M are gone entirely.
    const live = [liveWindow(1, [['api', [A]], ['Inbox', [D]]])];
    const plan = reconcile(session, live);
    expect(describePlan(plan)).toEqual([
      { group: '(pinned)', newGroup: false, newWindow: false, urls: [M] },
      { group: 'api', newGroup: false, newWindow: false, urls: [B] },
      { group: 'research', newGroup: true, newWindow: false, urls: [C] },
    ]);
    expect(formatPlan(plan)).toBe(
      ['(pinned) — 1 tab', `  ${M}`, 'api — 1 tab', `  ${B}`, 'research — 1 tab (new group)', `  ${C}`].join('\n'),
    );
  });

  it('is empty for an empty plan', () => {
    const live = [liveWindow(1, [['api', [A, B]], ['research', [C]], ['Inbox', [D]]], [M])];
    expect(describePlan(reconcile(session, live))).toEqual([]);
  });

  it('marks tabs that need a new window', () => {
    const plan = reconcile(session, []);
    expect(describePlan(plan).every((e) => e.newWindow && (e.group === '(pinned)' || e.newGroup))).toBe(true);
  });
});
