// Pure helpers over plain tab/group data — no chrome.* calls, unit tested.

export const NO_GROUP = -1;

export interface TabLike {
  id?: number;
  index: number;
  groupId: number;
  pinned: boolean;
  lastAccessed?: number;
}

/** Distinct group ids in tab-strip order. */
export function groupOrder(tabs: readonly TabLike[]): number[] {
  const order: number[] = [];
  for (const t of [...tabs].sort((a, b) => a.index - b.index)) {
    if (t.groupId !== NO_GROUP && !order.includes(t.groupId)) order.push(t.groupId);
  }
  return order;
}

/** Item `step` positions away from `current`, wrapping. Unknown `current` → first/last item. */
export function cycle<T>(items: readonly T[], current: T | undefined, step: 1 | -1): T | undefined {
  if (items.length === 0) return undefined;
  const i = current === undefined ? -1 : items.indexOf(current);
  if (i === -1) return step === 1 ? items[0] : items[items.length - 1];
  return items[(i + step + items.length) % items.length];
}

export const MRU_MAX = 32;

/** Moves `id` to the front of the MRU list. */
export function touchMru(mru: readonly number[], id: number, max = MRU_MAX): number[] {
  return [id, ...mru.filter((x) => x !== id)].slice(0, max);
}

/** The tab to activate when focusing a group: most recently used, else the first one. */
export function pickTabToActivate<T extends TabLike>(tabs: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const t of tabs) {
    if (!best) {
      best = t;
      continue;
    }
    const tl = t.lastAccessed ?? 0;
    const bl = best.lastAccessed ?? 0;
    if (tl > bl || (tl === bl && t.index < best.index)) best = t;
  }
  return best;
}

/** Initial MRU when none is recorded (fresh session or extension reload): groups ordered by
 * the most recent `lastAccessed` of their tabs. */
export function mruFromTabs(tabs: readonly TabLike[]): number[] {
  const latest = new Map<number, number>();
  for (const t of tabs) {
    if (t.groupId === NO_GROUP) continue;
    latest.set(t.groupId, Math.max(latest.get(t.groupId) ?? 0, t.lastAccessed ?? 0));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export const INBOX_TITLE = 'Inbox';

export type Placement = { kind: 'group'; groupId: number } | { kind: 'inbox' };

export interface PlacementInput {
  /** Created moments ago (seen in tabs.onCreated), as opposed to an existing stray tab. */
  isNew: boolean;
  /**
   * Created while no Chrome window had focus, i.e. by another app (a link clicked in Teams…).
   * `openerTabId` can't tell this apart: Chrome sets it to the active tab for external links too.
   */
  external: boolean;
  /** Group of the opener tab at sweep time, if any. */
  openerGroupId?: number;
  /** Most recently focused group of the window that still exists. */
  activeGroupId?: number;
}

/**
 * Where an ungrouped, unpinned tab belongs:
 * - a new tab opened from inside Chrome (Ctrl+T, bookmark, link from an ungrouped tab…)
 *   → the opener's group, else the active group;
 * - everything else (external app, dragged out, restored ungrouped, unpinned) → Inbox.
 */
export function decidePlacement(input: PlacementInput): Placement {
  if (input.isNew && !input.external) {
    if (input.openerGroupId !== undefined && input.openerGroupId !== NO_GROUP) {
      return { kind: 'group', groupId: input.openerGroupId };
    }
    if (input.activeGroupId !== undefined) return { kind: 'group', groupId: input.activeGroupId };
  }
  return { kind: 'inbox' };
}

/** goto-tab-N inside a group: 1-based, 9 = last (like Chrome's Ctrl+9). */
export function nthItem<T>(items: readonly T[], n: number): T | undefined {
  if (items.length === 0) return undefined;
  if (n >= 9) return items[items.length - 1];
  return items[n - 1];
}

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
}

/** Group titles are unique per window, compared case-insensitively. */
export function isTitleTaken(groups: readonly { id: number; title?: string }[], title: string, exceptId?: number): boolean {
  const wanted = normalizeTitle(title).toLowerCase();
  return groups.some((g) => g.id !== exceptId && normalizeTitle(g.title ?? '').toLowerCase() === wanted);
}

/** Validates a title for create/rename; returns an error message or undefined. */
export function titleError(
  groups: readonly { id: number; title?: string }[],
  title: string,
  exceptId?: number,
): string | undefined {
  if (normalizeTitle(title) === '') return 'Name cannot be empty';
  if (isTitleTaken(groups, title, exceptId)) return `A group named “${normalizeTitle(title)}” already exists in this window`;
  return undefined;
}

/**
 * Target index for chrome.tabGroups.move to swap a group with its neighbour (-1 left, 1 right).
 * Undefined when there is no neighbour, or when moving right would pass `pinnedLastId` (Inbox).
 */
export function moveGroupIndex(
  tabs: readonly TabLike[],
  groupId: number,
  dir: 1 | -1,
  pinnedLastId?: number,
): number | undefined {
  const spans: { id: number; first: number; last: number; count: number }[] = [];
  for (const t of [...tabs].sort((a, b) => a.index - b.index)) {
    if (t.groupId === NO_GROUP) continue;
    const span = spans[spans.length - 1];
    if (span && span.id === t.groupId) {
      span.last = t.index;
      span.count++;
    } else spans.push({ id: t.groupId, first: t.index, last: t.index, count: 1 });
  }
  const i = spans.findIndex((s) => s.id === groupId);
  const self = spans[i];
  if (!self || groupId === pinnedLastId) return undefined;
  if (dir === -1) return spans[i - 1]?.first;
  const next = spans[i + 1];
  if (!next || next.id === pinnedLastId) return undefined;
  return next.last - self.count + 1;
}
