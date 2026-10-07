// Reads the live browser into the shape reconcile() works on. Used by the service worker and
// by the picker (restore preview); both contexts have the chrome.* APIs.

import { NO_GROUP, groupOrder } from './model';
import type { LiveWindowState } from './reconcile';

export async function readLiveState(): Promise<LiveWindowState[]> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const titles = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title ?? '']));
  const url = (t: chrome.tabs.Tab) => t.url || t.pendingUrl || '';
  return windows
    .filter((w) => w.id !== undefined)
    .map((w) => {
      const tabs = [...(w.tabs ?? [])].sort((a, b) => a.index - b.index);
      return {
        id: w.id!,
        groups: groupOrder(tabs).map((id) => ({
          id,
          title: titles.get(id) ?? '',
          urls: tabs.filter((t) => t.groupId === id).map(url),
        })),
        otherUrls: tabs.filter((t) => t.groupId === NO_GROUP).map(url),
      };
    });
}

/** No groups anywhere and at most two tabs: Chrome restored (almost) nothing. */
export function isNearEmpty(live: readonly LiveWindowState[]): boolean {
  const groups = live.reduce((n, w) => n + w.groups.length, 0);
  const tabs = live.reduce((n, w) => n + w.otherUrls.length + w.groups.reduce((m, g) => m + g.urls.length, 0), 0);
  return groups === 0 && tabs <= 2;
}
