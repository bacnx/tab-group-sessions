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
