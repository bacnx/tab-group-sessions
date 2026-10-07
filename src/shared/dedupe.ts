// Duplicate-group merging (pure, unit tested). Duplicates appear when a session is restored
// twice — e.g. our restore, then Chrome's own "Restore" — inside one window or into a new one.
//
// A merge moves the duplicate's tabs into the kept group; tabs whose URL the kept group
// already has are closed instead.

import { INBOX_TITLE, normalizeTitle } from './model';

export interface DedupeTab {
  id: number;
  url: string;
}

export interface DedupeGroup {
  id: number;
  windowId: number;
  title: string;
  /** Index of the group's first tab in its window's strip. */
  index: number;
  tabs: DedupeTab[];
}

export interface Merge {
  from: number;
  fromWindowId: number;
  into: number;
  intoWindowId: number;
  move: number[];
  close: number[];
}

export type DedupeScope =
  /** Same-named groups inside one window merge into the first in strip order. */
  | { kind: 'window'; windowId: number }
  /** Manual merge from `windowId`: also pull same-named groups of other windows into it. */
  | { kind: 'pull'; windowId: number }
  /** Bulk restore into `windowId`: its groups that duplicate a group of another window (by
   * title AND mostly the same URLs) merge into that group. */
  | { kind: 'push'; windowId: number };

/** Share of a duplicate's URLs the other group must hold for an automatic cross-window merge. */
export const PUSH_MIN_OVERLAP = 0.5;

const keyOf = (g: DedupeGroup) => normalizeTitle(g.title).toLowerCase();
const isInbox = (g: DedupeGroup) => keyOf(g) === INBOX_TITLE.toLowerCase();

export function planMerges(groups: readonly DedupeGroup[], scope: DedupeScope): Merge[] {
  const merges: Merge[] = [];
  // URLs each kept group holds, growing as duplicates are merged into it.
  const urls = new Map<number, Set<string>>();
  const urlsOf = (g: DedupeGroup) => {
    let set = urls.get(g.id);
    if (!set) urls.set(g.id, (set = new Set(g.tabs.map((t) => t.url))));
    return set;
  };
  const merge = (from: DedupeGroup, into: DedupeGroup) => {
    const have = urlsOf(into);
    const move = from.tabs.filter((t) => !have.has(t.url));
    const close = from.tabs.filter((t) => have.has(t.url));
    for (const t of move) have.add(t.url);
    merges.push({ from: from.id, fromWindowId: from.windowId, into: into.id, intoWindowId: into.windowId, move: move.map((t) => t.id), close: close.map((t) => t.id) });
  };

  const titled = groups.filter((g) => keyOf(g));
  const local = titled.filter((g) => g.windowId === scope.windowId).sort((a, b) => a.index - b.index);
  const others = titled.filter((g) => g.windowId !== scope.windowId);

  // 1. Inside the window: keep the first of each title.
  const kept = new Map<string, DedupeGroup>();
  for (const g of local) {
    const keeper = kept.get(keyOf(g));
    if (keeper) merge(g, keeper);
    else kept.set(keyOf(g), g);
  }
  if (scope.kind === 'window') return merges;

  // 2. Across windows. Inbox is per window by design and never merges across windows.
  if (scope.kind === 'pull') {
    for (const g of others) {
      const keeper = kept.get(keyOf(g));
      if (keeper && !isInbox(g)) merge(g, keeper);
    }
    return merges;
  }
  for (const g of kept.values()) {
    if (isInbox(g) || g.tabs.length === 0) continue;
    const target = others.find((o) => {
      if (keyOf(o) !== keyOf(g)) return false;
      const have = new Set(o.tabs.map((t) => t.url));
      return g.tabs.filter((t) => have.has(t.url)).length / g.tabs.length >= PUSH_MIN_OVERLAP;
    });
    if (!target) continue;
    // Duplicates already merged into g follow it: their moved tabs now sit in g.
    const absorbed = merges.filter((m) => m.into === g.id).flatMap((m) => m.move);
    const all: DedupeGroup = { ...g, tabs: [...g.tabs, ...absorbed.map((id) => ({ id, url: urlOfTab(groups, id) }))] };
    merge(all, target);
  }
  return merges;
}

function urlOfTab(groups: readonly DedupeGroup[], tabId: number): string {
  for (const g of groups) for (const t of g.tabs) if (t.id === tabId) return t.url;
  return '';
}
