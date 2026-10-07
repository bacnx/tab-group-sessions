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
import { INBOX_TITLE, NO_GROUP, decidePlacement, groupOrder, isNewTabPageUrl } from '../shared/model';
import { getActiveTab, isNormalWindow, loadMru } from './focus';
import { enqueue } from './queue';
import { isReady } from './state';

const QUIET_MS = 300;
const MAX_WAIT_MS = 3000;
const NEW_TAB_TTL_MS = 10_000;

interface NewTab {
  openerTabId?: number;
  at: number;
  /** Created while Chrome had no focused window. Undefined until known (async lookup). */
  external?: boolean;
}

/** Tabs seen in tabs.onCreated, until a sweep handles them. In memory only: the sweep runs
 * well within the service worker's lifetime, and losing this just means "treat as stray". */
const newTabs = new Map<number, NewTab>();

// Whether any Chrome window has focus. Kept in memory and mirrored to storage.session because
// the service worker usually sleeps while the user is in another app.
//
// windows.onFocusChanged alone is not enough: opening an extension popup (our picker) reports
// WINDOW_ID_NONE, and closing it does NOT report the browser window again. So the focus flag
// is also set by evidence that the user is in Chrome: a keyboard command, or the picker
// being open/closed (tracked through a runtime port).
const FOCUS_KEY = 'chromeFocused';
let chromeFocused: boolean | undefined;
let openPickers = 0;

function setChromeFocused(focused: boolean): void {
  chromeFocused = focused;
  void chrome.storage.session.set({ [FOCUS_KEY]: focused });
}

export function recordFocusChange(windowId: number): void {
  const focused = windowId !== chrome.windows.WINDOW_ID_NONE;
  if (!focused && openPickers > 0) return; // focus moved into our own popup
  setChromeFocused(focused);
}

/** A keyboard command fired: Chrome has focus. */
export function recordUserInChrome(): void {
  setChromeFocused(true);
}

/** Picker pages hold a port named 'picker' while open. */
export function trackPickerPort(port: chrome.runtime.Port): void {
  if (port.name !== 'picker') return;
  openPickers++;
  setChromeFocused(true);
  port.onDisconnect.addListener(() => {
    openPickers = Math.max(0, openPickers - 1);
    setChromeFocused(true); // focus returns to the browser window, without an event
  });
}

export function recordNewTab(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined) return;
  const entry: NewTab = { openerTabId: tab.openerTabId, at: Date.now() };
  newTabs.set(tab.id, entry);
  if (isNewTabPageUrl(tab.pendingUrl || tab.url)) {
    entry.external = false; // Ctrl+T / + button; other apps never open the New Tab page
  } else if (chromeFocused !== undefined) {
    entry.external = !chromeFocused;
  } else {
    // Issued before any later focus event is handled, so it reads the pre-creation value.
    void chrome.storage.session.get(FOCUS_KEY).then((r) => {
      entry.external = r[FOCUS_KEY] === false;
    });
  }
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
    for (const t of strays) {
      const id = t.id!;
      const info = newTabs.get(id);
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
    log('grouping.sweep', { windowId, toGroup: Object.fromEntries(toGroup), toInbox, decisions });
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

async function keepInboxLast(windowId: number): Promise<void> {
  const inbox = findInbox(await chrome.tabGroups.query({ windowId }));
  if (!inbox) return;
  const order = groupOrder(await chrome.tabs.query({ windowId }));
  if (order[order.length - 1] !== inbox.id) await chrome.tabGroups.move(inbox.id, { index: -1 });
}

function pruneNewTabs(): void {
  const cutoff = Date.now() - NEW_TAB_TTL_MS;
  for (const [id, info] of newTabs) if (info.at < cutoff) newTabs.delete(id);
}
