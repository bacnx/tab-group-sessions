// High-level actions shared by keyboard commands and (later) the picker.
// Run them through the queue.

import { log } from '../shared/log';
import { NO_GROUP, cycle, groupOrder, nthItem, numberGroups } from '../shared/model';
import { focusGroup, getActiveTab, isNormalWindow, loadMru, syncFocus } from './focus';
import { sleep } from './queue';
import { getMru, setMru } from './state';

/** The group the user is working in: the active tab's group, else the most recent one. */
async function currentGroup(windowId: number): Promise<number | undefined> {
  const active = await getActiveTab(windowId);
  if (active && active.groupId !== NO_GROUP) return active.groupId;
  return (await loadMru(windowId))[0];
}

async function existingGroupIds(windowId: number): Promise<Set<number>> {
  return new Set((await chrome.tabGroups.query({ windowId })).map((g) => g.id));
}

/** next-group / prev-group: cycle through groups in tab-strip order, wrapping. */
export async function cycleGroup(windowId: number, step: 1 | -1): Promise<void> {
  const order = groupOrder(await chrome.tabs.query({ windowId }));
  const current = await currentGroup(windowId);
  const target = cycle(order, current, step);
  log('action.cycleGroup', { windowId, step, order, current, target });
  if (target !== undefined) await focusGroup(windowId, target);
}

/** last-group: toggle to the previously focused group (tmux `prefix L`). */
export async function lastGroup(windowId: number): Promise<void> {
  const existing = await existingGroupIds(windowId);
  const current = await currentGroup(windowId);
  const mru = await loadMru(windowId);
  const target = mru.find((id) => id !== current && existing.has(id));
  log('action.lastGroup', { windowId, mru, current, target });
  if (target !== undefined) await focusGroup(windowId, target);
}

/** focus-group-N: the Nth group from the left, 0 = Inbox (see numberGroups). */
export async function focusGroupNumber(windowId: number, n: number): Promise<void> {
  const byId = new Map((await chrome.tabGroups.query({ windowId })).map((g) => [g.id, g]));
  const ordered = groupOrder(await chrome.tabs.query({ windowId })).map((id) => ({ id, title: byId.get(id)?.title }));
  const target = [...numberGroups(ordered)].find(([, num]) => num === n)?.[0];
  log('action.focusGroupNumber', { windowId, n, target });
  if (target !== undefined) await focusGroup(windowId, target);
}

/**
 * A group disappeared. If it was the focused one, prefer the most recently used group over
 * the neighbour Chrome would pick.
 *
 * Observed order when the last tab of a group is closed: tabs.onUpdated(groupId=-1) →
 * tabGroups.onRemoved → tabs.onRemoved. So at this point the closing tab still exists,
 * ungrouped — exactly like a tab dragged out of its group. Wait briefly to tell them apart.
 */
export async function handleGroupRemoved(group: chrome.tabGroups.TabGroup): Promise<void> {
  const { windowId } = group;
  const mru = await getMru(windowId);
  const wasFocused = mru[0] === group.id;
  const remaining = mru.filter((id) => id !== group.id);
  await setMru(windowId, remaining);
  if (!wasFocused) return;

  const active = await getActiveTab(windowId);
  if (active?.pinned) return;
  if (active && active.groupId !== NO_GROUP) {
    // The active tab moved into another group.
    await syncFocus(windowId);
    return;
  }

  await sleep(200);
  if (!(await isNormalWindow(windowId))) return; // window closed
  if (active?.id !== undefined && (await chrome.tabs.get(active.id).catch(() => undefined))) {
    return; // tab survived: it was dragged out of the group, not closed
  }
  const existing = await existingGroupIds(windowId);
  const target = remaining.find((id) => existing.has(id));
  if (target !== undefined) await focusGroup(windowId, target);
}

/** Tabs of the active tab's group in strip order, with the active tab. */
async function currentGroupTabs(windowId: number) {
  const active = await getActiveTab(windowId);
  if (!active?.id || active.groupId === NO_GROUP) return undefined;
  const tabs = (await chrome.tabs.query({ windowId, groupId: active.groupId })).sort((a, b) => a.index - b.index);
  return { active, tabs };
}

/** next-tab-in-group / prev-tab-in-group: cycle inside the current group, wrapping. */
export async function cycleTabInGroup(windowId: number, step: 1 | -1): Promise<void> {
  const current = await currentGroupTabs(windowId);
  if (!current) return;
  const target = cycle(
    current.tabs.map((t) => t.id),
    current.active.id,
    step,
  );
  if (target !== undefined && target !== current.active.id) await chrome.tabs.update(target, { active: true });
}

/** goto-tab-N: Nth tab of the current group, 9 = last. */
export async function gotoTabInGroup(windowId: number, n: number): Promise<void> {
  const current = await currentGroupTabs(windowId);
  const target = current && nthItem(current.tabs, n);
  if (target?.id !== undefined && !target.active) await chrome.tabs.update(target.id, { active: true });
}

/** Picker: focus a group, bringing its window to the front. */
export async function focusGroupById(groupId: number): Promise<void> {
  const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
  if (!group) return;
  await focusGroup(group.windowId, groupId);
  await chrome.windows.update(group.windowId, { focused: true });
}

/** Picker: activate a tab, bringing its window to the front (focus rule follows via onActivated). */
export async function activateTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}
