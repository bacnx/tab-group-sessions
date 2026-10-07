import { describe, expect, it } from 'vitest';
import { NO_GROUP } from './model';
import {
  buildWindows,
  countTabs,
  hashWindows,
  isSnapshotUrl,
  isSuspicious,
  latestGood,
  pushSnapshot,
  type LiveTab,
  type LiveWindow,
  type Snapshot,
} from './snapshot';

const EXT = 'chrome-extension://abc/';

const t = (index: number, groupId: number, url: string, extra: Partial<LiveTab> = {}): LiveTab => ({
  index,
  url,
  title: url,
  groupId,
  pinned: false,
  active: false,
  ...extra,
});

const live: LiveWindow = {
  focused: true,
  groups: [
    { id: 2, title: 'research', color: 'red', collapsed: true },
    { id: 1, title: 'api', color: 'blue', collapsed: false },
    { id: 9, title: 'Inbox', color: 'grey', collapsed: true },
  ],
  tabs: [
    t(0, NO_GROUP, 'https://mail.example/', { pinned: true }),
    t(1, 1, 'https://api.dev/login', { active: true }),
    t(2, 1, 'chrome://newtab/'),
    t(3, 2, 'https://github.com/pulls'),
    t(4, 9, `${EXT}diagnostics.html`),
  ],
};

const snap = (id: string, tabCount: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  id,
  ts: 0,
  hash: id,
  tabCount,
  suspicious: false,
  windows: [],
  ...extra,
});

describe('isSnapshotUrl', () => {
  it('drops the New Tab page, split-view helpers and our own pages', () => {
    expect(isSnapshotUrl('https://x.dev/', EXT)).toBe(true);
    expect(isSnapshotUrl('chrome://settings/', EXT)).toBe(true);
    expect(isSnapshotUrl('chrome://newtab/', EXT)).toBe(false);
    expect(isSnapshotUrl('chrome://tab-search.top-chrome/split_new_tab_page.html', EXT)).toBe(false);
    expect(isSnapshotUrl(`${EXT}picker.html`, EXT)).toBe(false);
    expect(isSnapshotUrl('', EXT)).toBe(false);
  });
});

describe('buildWindows', () => {
  const [w] = buildWindows([live], EXT);

  it('keeps groups in strip order with their restorable tabs', () => {
    expect(w!.groups.map((g) => g.title)).toEqual(['api', 'research', 'Inbox']);
    expect(w!.groups[0]!.tabs.map((x) => x.url)).toEqual(['https://api.dev/login']);
    expect(w!.groups[2]!.tabs).toEqual([]);
  });

  it('records pinned tabs, the active group and collapsed state', () => {
    expect(w!.pinned.map((x) => x.url)).toEqual(['https://mail.example/']);
    expect(w!.activeGroup).toBe('api');
    expect(w!.groups[1]!.collapsed).toBe(true);
  });

  it('counts restorable tabs only', () => {
    expect(countTabs([w!])).toBe(3);
  });

  it('skips windows with nothing to restore', () => {
    expect(buildWindows([{ focused: false, groups: [], tabs: [t(0, NO_GROUP, 'chrome://newtab/')] }], EXT)).toEqual([]);
  });

  it('hashes deterministically and changes with content', () => {
    const again = buildWindows([live], EXT);
    expect(hashWindows(again)).toBe(hashWindows([w!]));
    const collapsedApi = buildWindows(
      [{ ...live, groups: live.groups.map((g) => (g.id === 1 ? { ...g, collapsed: true } : g)) }],
      EXT,
    );
    expect(hashWindows(collapsedApi)).not.toBe(hashWindows([w!]));
  });
});

describe('isSuspicious', () => {
  it('flags losing more than half of a sizeable session', () => {
    expect(isSuspicious(snap('a', 20), 9)).toBe(true);
    expect(isSuspicious(snap('a', 20), 10)).toBe(false);
    expect(isSuspicious(snap('a', 4), 0)).toBe(false);
    expect(isSuspicious(undefined, 0)).toBe(false);
  });
});

describe('pushSnapshot', () => {
  it('skips a snapshot identical to the latest', () => {
    const list = [snap('a', 3)];
    expect(pushSnapshot(list, snap('a', 3), 10)).toEqual(list);
  });

  it('keeps newest first and trims to max', () => {
    let list: Snapshot[] = [];
    for (const id of ['a', 'b', 'c', 'd']) list = pushSnapshot(list, snap(id, 3), 3);
    expect(list.map((s) => s.id)).toEqual(['d', 'c', 'b']);
  });

  it('never evicts the latest good snapshot', () => {
    let list: Snapshot[] = [snap('good', 30)];
    for (const id of ['s1', 's2', 's3']) list = pushSnapshot(list, snap(id, 1, { suspicious: true }), 3);
    expect(list.map((s) => s.id)).toEqual(['s3', 's2', 'good']);
    expect(latestGood(list)?.id).toBe('good');
  });
});
