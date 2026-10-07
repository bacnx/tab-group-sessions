// Group management actions triggered from the picker or keyboard commands. Run through the
// queue. Mutations that need validation return an ActionResult the picker can display.

import { log } from '../shared/log';
import type { ActionResult } from '../shared/messages';
import { INBOX_TITLE, NO_GROUP, moveGroupIndex, normalizeTitle, titleError, type GroupColor } from '../shared/model';
import { focusGroup, getActiveTab, loadMru } from './focus';
import { findInbox, groupTabs } from './grouping';

const ok: ActionResult = { ok: true };
const fail = (error: string): ActionResult => ({ ok: false, error });

/** Moves the active tab into `groupId`, or into a new group titled `newTitle`. Focus follows
 * the tab (it stays active, so the focus rule expands its new group). */
export async function moveActiveTab(windowId: number, groupId?: number, newTitle?: string): Promise<ActionResult> {
  const active = await getActiveTab(windowId);
  if (active?.id === undefined) return fail('No active tab');
  if (active.pinned) return fail('Pinned tabs stay pinned — unpin the tab first');

  if (groupId !== undefined) {
    if (groupId === active.groupId) return ok;
    await groupTabs([active.id], { groupId });
    return ok;
  }
  const groups = await chrome.tabGroups.query({ windowId });
  const error = titleError(groups, newTitle ?? '');
  if (error) return fail(error);
  const created = await groupTabs([active.id], { windowId });
  await chrome.tabGroups.update(created, { title: normalizeTitle(newTitle!) });
  await focusGroup(windowId, created);
  return ok;
}

/** Creates a group holding a fresh New Tab and focuses it. */
export async function newGroup(windowId: number, title: string): Promise<ActionResult> {
  const groups = await chrome.tabGroups.query({ windowId });
  const error = titleError(groups, title);
  if (error) return fail(error);
  // Grouped right away inside this queued task, so the stray sweep never sees it ungrouped.
  const tab = await chrome.tabs.create({ windowId, active: true });
  if (tab.id === undefined) return fail('Could not create a tab');
  const groupId = await groupTabs([tab.id], { windowId });
  await chrome.tabGroups.update(groupId, { title: normalizeTitle(title) });
  await focusGroup(windowId, groupId);
  return ok;
}

export async function renameGroup(groupId: number, title: string): Promise<ActionResult> {
  const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
  if (!group) return fail('The group no longer exists');
  const groups = await chrome.tabGroups.query({ windowId: group.windowId });
  const error = titleError(groups, title, groupId);
  if (error) return fail(error);
  await chrome.tabGroups.update(groupId, { title: normalizeTitle(title) });
  return ok;
}

export async function setGroupColor(groupId: number, color: GroupColor): Promise<ActionResult> {
  await chrome.tabGroups.update(groupId, { color });
  return ok;
}

const LAST_CLOSED_KEY = 'lastClosedGroup';

export interface ClosedGroup {
  windowId: number;
  title: string;
  color: string;
  urls: string[];
  at: number;
}

/**
 * Closes every tab of the group, for good. Focus moves to the most recent other group first;
 * if nothing would be left in the window, a New Tab is put in a fresh Inbox first so the
 * window (and with a single window, Chrome) doesn't close.
 */
export async function closeGroup(groupId: number): Promise<ActionResult> {
  const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
  if (!group) return fail('The group no longer exists');
  const { windowId } = group;
  const all = await chrome.tabs.query({ windowId });
  const members = all.filter((t) => t.groupId === groupId);
  const others = all.filter((t) => t.groupId !== groupId);

  if (others.length === 0) {
    const tab = await chrome.tabs.create({ windowId, active: true });
    if (tab.id !== undefined) {
      const inbox = await groupTabs([tab.id], { windowId });
      await chrome.tabGroups.update(inbox, { title: INBOX_TITLE, color: 'grey' });
    }
  } else {
    const existing = new Set((await chrome.tabGroups.query({ windowId })).map((g) => g.id));
    const target = (await loadMru(windowId)).find((id) => id !== groupId && existing.has(id));
    if (target !== undefined) await focusGroup(windowId, target);
  }

  const closed: ClosedGroup = {
    windowId,
    title: group.title ?? '',
    color: group.color,
    urls: members.map((t) => t.url || t.pendingUrl || '').filter(Boolean),
    at: Date.now(),
  };
  await chrome.storage.session.set({ [LAST_CLOSED_KEY]: closed });
  await chrome.tabs.remove(members.map((t) => t.id!).filter((id) => id !== undefined));
  log('manage.closeGroup', { title: closed.title, tabs: members.length });
  return ok;
}

/** move-group-left / move-group-right: swap the current group with its neighbour. Inbox
 * stays last: it never moves and nothing moves past it. */
export async function moveCurrentGroup(windowId: number, dir: 1 | -1): Promise<void> {
  const active = await getActiveTab(windowId);
  if (!active || active.groupId === NO_GROUP) return;
  const tabs = await chrome.tabs.query({ windowId });
  const inbox = findInbox(await chrome.tabGroups.query({ windowId }));
  const index = moveGroupIndex(tabs, active.groupId, dir, inbox?.id);
  if (index !== undefined) await chrome.tabGroups.move(active.groupId, { index });
}
