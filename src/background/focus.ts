// Focus engine: exactly one expanded group per window — the group of the active tab.
// All functions are idempotent and re-read state from Chrome; call them through the queue.

import { NO_GROUP, mruFromTabs, pickTabToActivate, touchMru } from '../shared/model';
import { getMru, setMru } from './state';

export async function isNormalWindow(windowId: number): Promise<boolean> {
  const win = await chrome.windows.get(windowId).catch(() => undefined);
  return win?.type === 'normal';
}

/**
 * MRU for a window. storage.session is empty after a browser restart or an extension reload;
 * seed it from tab access times so last-group works immediately.
 */
export async function loadMru(windowId: number): Promise<number[]> {
  const mru = await getMru(windowId);
  if (mru.length > 0) return mru;
  const seeded = mruFromTabs(await chrome.tabs.query({ windowId }));
  if (seeded.length > 0) await setMru(windowId, seeded);
  return seeded;
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

  const mru = await loadMru(windowId);
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
