// Snapshot model: what is saved to storage.local so a session can be restored after a crash
// or a restore that Chrome got wrong. Pure, unit tested; capture lives in background/snapshot.ts.

import { NO_GROUP, groupOrder, isNewTabPageUrl } from './model';

/** storage.local key: Snapshot[] newest first. */
export const SNAPSHOTS_KEY = 'snapshots';

export interface SnapTab {
  url: string;
  title: string;
}

export interface SnapGroup {
  title: string;
  color: string;
  collapsed: boolean;
  tabs: SnapTab[];
}

export interface SnapWindow {
  focused: boolean;
  /** Title of the group holding the active tab, if any. */
  activeGroup?: string;
  pinned: SnapTab[];
  /** In tab-strip order. */
  groups: SnapGroup[];
  /** Normally empty (strays go to Inbox); kept so nothing is silently lost. */
  ungrouped: SnapTab[];
}

export interface Snapshot {
  id: string;
  ts: number;
  hash: string;
  tabCount: number;
  /** Lost more than half of the previous snapshot's tabs: kept, but skipped by restore. */
  suspicious: boolean;
  windows: SnapWindow[];
}

/** Plain view of the live browser state, as read from the chrome.* APIs. */
export interface LiveTab {
  index: number;
  url: string;
  title: string;
  groupId: number;
  pinned: boolean;
  active: boolean;
}

export interface LiveGroup {
  id: number;
  title: string;
  color: string;
  collapsed: boolean;
}

export interface LiveWindow {
  focused: boolean;
  tabs: LiveTab[];
  groups: LiveGroup[];
}

/** Tabs worth restoring: not empty, not the New Tab page, not Chrome's transient helpers or
 * our own extension pages. */
export function isSnapshotUrl(url: string, extensionOrigin: string): boolean {
  if (!url || isNewTabPageUrl(url)) return false;
  if (url.startsWith('chrome://tab-search.top-chrome/')) return false;
  if (extensionOrigin && url.startsWith(extensionOrigin)) return false;
  return true;
}

export function buildWindows(live: readonly LiveWindow[], extensionOrigin: string): SnapWindow[] {
  const result: SnapWindow[] = [];
  for (const w of live) {
    const tabs = [...w.tabs].sort((a, b) => a.index - b.index);
    const keep = (t: LiveTab) => isSnapshotUrl(t.url, extensionOrigin);
    const toSnap = (t: LiveTab): SnapTab => ({ url: t.url, title: t.title });
    const groupsById = new Map(w.groups.map((g) => [g.id, g]));

    const groups: SnapGroup[] = [];
    for (const id of groupOrder(tabs)) {
      const g = groupsById.get(id);
      if (!g) continue;
      groups.push({
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
        tabs: tabs.filter((t) => t.groupId === id && keep(t)).map(toSnap),
      });
    }
    const active = tabs.find((t) => t.active);
    const activeGroup = active && active.groupId !== NO_GROUP ? groupsById.get(active.groupId)?.title : undefined;
    const window: SnapWindow = {
      focused: w.focused,
      activeGroup,
      pinned: tabs.filter((t) => t.pinned && keep(t)).map(toSnap),
      groups,
      ungrouped: tabs.filter((t) => !t.pinned && t.groupId === NO_GROUP && keep(t)).map(toSnap),
    };
    if (countWindowTabs(window) > 0 || groups.length > 0) result.push(window);
  }
  return result;
}

function countWindowTabs(w: SnapWindow): number {
  return w.pinned.length + w.ungrouped.length + w.groups.reduce((n, g) => n + g.tabs.length, 0);
}

export function countTabs(windows: readonly SnapWindow[]): number {
  return windows.reduce((n, w) => n + countWindowTabs(w), 0);
}

/** FNV-1a over the JSON form; only used to skip writing identical snapshots. */
export function hashWindows(windows: readonly SnapWindow[]): string {
  const s = JSON.stringify(windows);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const SUSPICIOUS_MIN_PREVIOUS = 6;

export function isSuspicious(previous: Snapshot | undefined, tabCount: number): boolean {
  if (!previous || previous.tabCount < SUSPICIOUS_MIN_PREVIOUS) return false;
  return tabCount < previous.tabCount / 2;
}

/** Newest first. */
export function latestGood(list: readonly Snapshot[]): Snapshot | undefined {
  return list.find((s) => !s.suspicious);
}

/**
 * Adds `snap` (newest first) unless it equals the latest one, keeping at most `max` entries —
 * but never evicting the most recent good snapshot, so a run of suspicious ones can't wipe it.
 */
export function pushSnapshot(list: readonly Snapshot[], snap: Snapshot, max: number): Snapshot[] {
  if (list[0]?.hash === snap.hash) return [...list];
  const next = [snap, ...list];
  if (next.length <= max) return next;
  const kept = next.slice(0, max);
  const good = latestGood(next);
  if (good && !kept.includes(good)) kept[kept.length - 1] = good;
  return kept;
}
