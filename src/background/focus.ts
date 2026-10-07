// Focus engine: exactly one expanded group per window — the group of the active tab.
// All functions are idempotent and re-read state from Chrome; call them through the queue.

import { NO_GROUP, pickTabToActivate, touchMru } from '../shared/model';
import { getMru, setMru } from './state';

/** Windows the engine must not touch (the diagnostics probe window). */
export const ignoredWindows = new Set<number>();

export async function isNormalWindow(windowId: number): Promise<boolean> {
  if (ignoredWindows.has(windowId)) return false;
  const win = await chrome.windows.get(windowId).catch(() => undefined);
  return win?.type === 'normal';
}

export async function getActiveTab(windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const [active] = await chrome.tabs.query({ windowId, active: true });
  return active;
}

/**
 * Focuses `groupId` in `windowId`: activates its most recently used tab (unless the active tab
 * is already in it), expands it, collapses every other group of the window.
 * Order matters: Chrome lets the API collapse the group holding the active tab, so the
 * active tab must be moved into the target group first.
 */
export async function focusGroup(windowId: number, groupId: number): Promise<void> {
  const members = await chrome.tabs.query({ windowId, groupId });
  if (members.length === 0) return;

  const active = await getActiveTab(windowId);
  if (active?.groupId !== groupId) {
    const target = pickTabToActivate(members);
    if (target?.id !== undefined) await chrome.tabs.update(target.id, { active: true });
  }

  const groups = await chrome.tabGroups.query({ windowId });
  const self = groups.find((g) => g.id === groupId);
  if (self?.collapsed) await chrome.tabGroups.update(groupId, { collapsed: false });
  for (const g of groups) {
    if (g.id !== groupId && !g.collapsed) await chrome.tabGroups.update(g.id, { collapsed: true });
  }

  const mru = await getMru(windowId);
  if (mru[0] !== groupId) await setMru(windowId, touchMru(mru, groupId));
}

/** Re-applies the focus rule for a window from its current active tab. */
export async function syncFocus(windowId: number): Promise<void> {
  if (!(await isNormalWindow(windowId))) return;
  const active = await getActiveTab(windowId);
  // Pinned or ungrouped active tab: leave the groups as they are.
  if (!active || active.pinned || active.groupId === NO_GROUP) return;
  await focusGroup(windowId, active.groupId);
}
