import { describe, expect, it } from 'vitest';
import { NO_GROUP } from './model';
import { search, type PickerData, type PickerTab } from './search';

const tab = (id: number, groupId: number, title: string, url: string, extra: Partial<PickerTab> = {}): PickerTab => ({
  id,
  windowId: 1,
  groupId,
  index: id,
  title,
  url,
  pinned: false,
  active: false,
  ...extra,
});

const data: PickerData = {
  currentWindowId: 1,
  currentGroupId: 10,
  groups: [
    { id: 10, windowId: 1, title: 'api', color: 'blue', tabCount: 2 },
    { id: 20, windowId: 1, title: 'Nghiên cứu', color: 'red', tabCount: 1 },
    { id: 30, windowId: 2, title: 'apps', color: 'green', tabCount: 1 },
  ],
  tabs: [
    tab(1, 10, 'Login page', 'https://api.dev/login', { active: true, lastAccessed: 50 }),
    tab(2, 10, 'Swagger', 'https://api.dev/docs', { lastAccessed: 40 }),
    tab(3, 20, 'Pull requests', 'https://github.com/pulls', { lastAccessed: 60 }),
    tab(4, 30, 'Store', 'https://apps.example', { windowId: 2, lastAccessed: 10 }),
    tab(5, NO_GROUP, 'Mail', 'https://mail.example', { pinned: true, lastAccessed: 5 }),
  ],
};

const ids = (rows: ReturnType<typeof search>) =>
  rows.map((r) => (r.kind === 'group' ? `g${r.group.id}` : `t${r.tab.id}`));

describe('search', () => {
  it('lists groups (current window first) then tabs by recency for an empty query', () => {
    expect(ids(search(data, ''))).toEqual(['g10', 'g20', 'g30', 't3', 't2', 't4', 't5']);
  });

  it('puts the matching group row above tabs', () => {
    expect(ids(search(data, 'api'))[0]).toBe('g10');
  });

  it('narrows to tabs of a group with "group tab" queries', () => {
    expect(ids(search(data, 'api login'))).toEqual(['t1']);
  });

  it('finds tabs anywhere by title, ignoring diacritics on groups', () => {
    expect(ids(search(data, 'pull request'))).toEqual(['t3']);
    expect(ids(search(data, 'nghien'))[0]).toBe('g20');
  });

  it('prefers the current window on equal scores', () => {
    const rows = search(data, 'ap');
    const groupIds = rows.filter((r) => r.kind === 'group').map((r) => (r.kind === 'group' ? r.group.id : 0));
    expect(groupIds.indexOf(10)).toBeLessThan(groupIds.indexOf(30));
  });
});
