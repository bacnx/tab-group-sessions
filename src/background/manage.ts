// Group management actions triggered from the picker or keyboard commands. Run through the
// queue. Mutations that need validation return an ActionResult the picker can display.

import { log } from '../shared/log';
import type { ActionResult } from '../shared/messages';
import { INBOX_TITLE, NO_GROUP, moveGroupIndex, normalizeTitle, pushClosed, titleError, type GroupColor } from '../shared/model';
import { focusGroup, getActiveTab, isNormalWindow, loadMru } from './focus';
import { findInbox, groupTabs, keepInboxLast } from './grouping';

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

/** storage.session: groups closed from the keyboard, most recent first (reopen pops them). */
const CLOSED_GROUPS_KEY = 'closedGroups';
const CLOSED_GROUPS_MAX = 10;

export interface ClosedGroup {
  windowId: number;
  title: string;
  color: string;
  urls: string[];
  at: number;
}

async function loadClosed(): Promise<ClosedGroup[]> {
  const stored = (await chrome.storage.session.get(CLOSED_GROUPS_KEY))[CLOSED_GROUPS_KEY];
  return Array.isArray(stored) ? (stored as ClosedGroup[]) : [];
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
  if (closed.urls.length) {
    await chrome.storage.session.set({ [CLOSED_GROUPS_KEY]: pushClosed(await loadClosed(), closed, CLOSED_GROUPS_MAX) });
  }
  await chrome.tabs.remove(members.map((t) => t.id!).filter((id) => id !== undefined));
  log('manage.closeGroup', { title: closed.title, tabs: members.length });
  return ok;
}

/**
 * Reopens the most recently closed group (keyboard close only — Chrome's own Ctrl+Shift+T
 * covers groups closed with the mouse) in the window it came from, else in `windowId`.
 * If that window already has a group with the same title, the missing URLs are added to it,
 * so titles stay unique. The reopened group is focused on its first tab.
 */
export async function reopenClosedGroup(windowId: number): Promise<void> {
  const [closed, ...rest] = await loadClosed();
  if (!closed) {
    log('manage.reopen', { nothing: true });
    return;
  }
  await chrome.storage.session.set({ [CLOSED_GROUPS_KEY]: rest });
  const target = (await isNormalWindow(closed.windowId)) ? closed.windowId : windowId;

  const key = normalizeTitle(closed.title).toLowerCase();
  const same = key
    ? (await chrome.tabGroups.query({ windowId: target })).find((g) => normalizeTitle(g.title ?? '').toLowerCase() === key)
    : undefined;
  const present = same
    ? new Set((await chrome.tabs.query({ windowId: target, groupId: same.id })).map((t) => t.url || t.pendingUrl))
    : new Set<string | undefined>();

  const ids: number[] = [];
  for (const url of closed.urls.filter((u) => !present.has(u))) {
    // Inactive while grouping, inside this queued task: the stray sweep never sees them.
    const tab = await chrome.tabs.create({ windowId: target, url, active: false }).catch(() => undefined);
    if (tab?.id !== undefined) ids.push(tab.id);
  }
  let groupId = same?.id;
  if (ids.length) {
    groupId = await groupTabs(ids, groupId !== undefined ? { groupId } : { windowId: target });
    if (!same) await chrome.tabGroups.update(groupId, { title: closed.title || undefined, color: closed.color as GroupColor });
    await keepInboxLast(target);
    await chrome.tabs.update(ids[0]!, { active: true });
  }
  if (groupId !== undefined) await focusGroup(target, groupId);
  if (target !== windowId) await chrome.windows.update(target, { focused: true });
  log('manage.reopen', { title: closed.title, tabs: ids.length, mergedInto: same?.id });
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
