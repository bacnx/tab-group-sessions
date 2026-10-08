// Every non-pinned tab belongs to a group. New tabs join the opener's / active group, other
// strays go to the per-window Inbox, which is kept as the last group of the strip.
//
// Work is done by a debounced per-window sweep instead of reacting to single events, because
// Chrome passes through transient ungrouped states we must not act on (observed in M0):
// - a closing tab is ungrouped right before it is removed;
// - a restored window creates the first tab of each group ungrouped, then groups it;
// - split view creates helper tabs that are ungrouped/regrouped/removed within milliseconds.
// After a short quiet period the sweep re-reads the window and only then acts.

import { log } from '../shared/log';
import { INBOX_TITLE, NO_GROUP, decidePlacement, groupOrder, isExternalTransition, isNewTabPageUrl } from '../shared/model';
import { getActiveTab, isNormalWindow, loadMru } from './focus';
import { enqueue } from './queue';
import { isReady } from './state';

const QUIET_MS = 300;
const MAX_WAIT_MS = 3000;
const NEW_TAB_TTL_MS = 10_000;
/** How long a new tab may stay ungrouped while waiting for its first commit. */
const COMMIT_WAIT_MS = 5000;

interface NewTab {
  windowId: number;
  openerTabId?: number;
  at: number;
  /** Opened by another app. Undefined until the first navigation commits. */
  external?: boolean;
}

/** Tabs seen in tabs.onCreated, until a sweep handles them. In memory only: the sweep runs
 * well within the service worker's lifetime, and losing this just means "treat as stray". */
const newTabs = new Map<number, NewTab>();

// A new tab is external (opened by another app) when its first committed navigation has the
// `start_page` transition. Window focus can't tell: on Windows Chrome reports no focus loss when
// the user switches to another app, reports one after Alt+… shortcuts, and opening an extension
// popup reports a loss that its closing never undoes.

export function recordNewTab(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined) return;
  const entry: NewTab = { windowId: tab.windowId, openerTabId: tab.openerTabId, at: Date.now() };
  // Ctrl+T / + button; other apps never open the New Tab page.
  if (isNewTabPageUrl(tab.pendingUrl || tab.url)) entry.external = false;
  newTabs.set(tab.id, entry);
}

/** webNavigation.onCommitted: the first top-frame commit of a new tab decides `external`. */
export function recordCommit(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void {
  if (details.frameId !== 0) return;
  const entry = newTabs.get(details.tabId);
  if (!entry || entry.external !== undefined) return;
  entry.external = isExternalTransition(details.transitionType);
  scheduleSweep(entry.windowId);
}

const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; firstAt: number }>();

/** Debounced: the sweep runs once the window has been quiet for `quietMs` (max 3 s). */
export function scheduleSweep(windowId: number, quietMs = QUIET_MS): void {
  const now = Date.now();
  const pending = timers.get(windowId);
  if (pending) clearTimeout(pending.timer);
  const firstAt = pending?.firstAt ?? now;
  const wait = Math.max(0, Math.min(quietMs, firstAt + MAX_WAIT_MS - now));
  const timer = setTimeout(() => {
    timers.delete(windowId);
    void enqueue('sweep', () => sweepWindow(windowId));
  }, wait);
  timers.set(windowId, { timer, firstAt });
}

export async function scheduleSweepAll(quietMs?: number): Promise<void> {
  for (const win of await chrome.windows.getAll({ windowTypes: ['normal'] })) {
    if (win.id !== undefined) scheduleSweep(win.id, quietMs);
  }
}

// Split view helper pages live and die within milliseconds; never adopt them.
function isTransientHelper(tab: chrome.tabs.Tab): boolean {
  const url = tab.url || tab.pendingUrl || '';
  return url.startsWith('chrome://tab-search.top-chrome/');
}

/** chrome.tabs.group with a plain array; returns the group id. */
export async function groupTabs(tabIds: number[], target: { groupId: number } | { windowId: number }): Promise<number> {
  const [first, ...rest] = tabIds;
  if (first === undefined) throw new Error('groupTabs: no tabs');
  const options: chrome.tabs.GroupOptions =
    'groupId' in target
      ? { tabIds: [first, ...rest], groupId: target.groupId }
      : { tabIds: [first, ...rest], createProperties: { windowId: target.windowId } };
  return (await chrome.tabs.group(options)) as unknown as number;
}

export function findInbox(groups: chrome.tabGroups.TabGroup[]): chrome.tabGroups.TabGroup | undefined {
  return groups.find((g) => g.title === INBOX_TITLE);
}

async function sweepWindow(windowId: number): Promise<void> {
  pruneNewTabs();
  // While Chrome is restoring the session, restored tabs pass through ungrouped states;
  // restore.ts sweeps every window once booting is over.
  if (!(await isReady())) return;
  if (!(await isNormalWindow(windowId))) return;

  const tabs = await chrome.tabs.query({ windowId });
  const strays = tabs.filter((t) => t.id !== undefined && t.groupId === NO_GROUP && !t.pinned && !isTransientHelper(t));

  if (strays.length > 0) {
    const groups = await chrome.tabGroups.query({ windowId });
    const existing = new Set(groups.map((g) => g.id));
    const activeGroupId = (await loadMru(windowId)).find((id) => existing.has(id));

    const toGroup = new Map<number, number[]>();
    const toInbox: number[] = [];
    const decisions: unknown[] = [];
    let waitMs = 0;
    for (const t of strays) {
      const id = t.id!;
      const info = newTabs.get(id);
      if (info?.external === undefined && info !== undefined) {
        // Not committed yet: wait for recordCommit, then fall back to "opened inside Chrome".
        const left = info.at + COMMIT_WAIT_MS - Date.now();
        if (left > 0) {
          waitMs = waitMs > 0 ? Math.min(waitMs, left) : left;
          continue;
        }
      }
      newTabs.delete(id);
      const opener = info?.openerTabId !== undefined ? tabs.find((o) => o.id === info.openerTabId) : undefined;
      const placement = decidePlacement({
        isNew: info !== undefined,
        external: info?.external === true,
        openerGroupId: opener?.groupId,
        activeGroupId,
      });
      if (info) decisions.push({ id, external: info.external, opener: info.openerTabId, placement: placement.kind });
      if (placement.kind === 'inbox') toInbox.push(id);
      else toGroup.set(placement.groupId, [...(toGroup.get(placement.groupId) ?? []), id]);
    }

    for (const [groupId, tabIds] of toGroup) {
      await groupTabs(tabIds, { groupId });
    }
    if (toInbox.length > 0) await addToInbox(windowId, groups, toInbox);
    if (decisions.length > 0 || toInbox.length > 0) {
      log('grouping.sweep', { windowId, toGroup: Object.fromEntries(toGroup), toInbox, decisions });
    }
    if (waitMs > 0) scheduleSweep(windowId, waitMs);
  }

  await keepInboxLast(windowId);
}

async function addToInbox(windowId: number, groups: chrome.tabGroups.TabGroup[], tabIds: number[]): Promise<void> {
  const inbox = findInbox(groups);
  if (inbox) {
    await groupTabs(tabIds, { groupId: inbox.id });
    return;
  }
  const groupId = await groupTabs(tabIds, { windowId });
  await chrome.tabGroups.update(groupId, { title: INBOX_TITLE, color: 'grey' });
  // A fresh group is expanded; keep the one-expanded-group rule unless the user is in it.
  const active = await getActiveTab(windowId);
  if (active && !active.pinned && active.groupId !== groupId) {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  }
}

export async function keepInboxLast(windowId: number): Promise<void> {
  const inbox = findInbox(await chrome.tabGroups.query({ windowId }));
  if (!inbox) return;
  const order = groupOrder(await chrome.tabs.query({ windowId }));
  if (order[order.length - 1] !== inbox.id) await chrome.tabGroups.move(inbox.id, { index: -1 });
}

function pruneNewTabs(): void {
  const cutoff = Date.now() - NEW_TAB_TTL_MS;
  for (const [id, info] of newTabs) if (info.at < cutoff) newTabs.delete(id);
}
