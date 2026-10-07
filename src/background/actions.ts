// High-level actions shared by keyboard commands and (later) the picker.
// Run them through the queue.

import { log } from '../shared/log';
import { NO_GROUP, cycle, groupOrder } from '../shared/model';
import { focusGroup, getActiveTab, isNormalWindow, syncFocus } from './focus';
import { sleep } from './queue';
import { getMru, setMru } from './state';

/** The group the user is working in: the active tab's group, else the most recent one. */
async function currentGroup(windowId: number): Promise<number | undefined> {
  const active = await getActiveTab(windowId);
  if (active && active.groupId !== NO_GROUP) return active.groupId;
  return (await getMru(windowId))[0];
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
  const mru = await getMru(windowId);
  const target = mru.find((id) => id !== current && existing.has(id));
  log('action.lastGroup', { windowId, mru, current, target });
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
