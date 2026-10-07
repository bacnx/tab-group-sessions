// Restore (M6). Chrome's own session restore runs first; we wait for it to settle, reconcile
// the latest good snapshot against what is open and only ADD what is missing:
// - near-empty state (nothing restored) → restore automatically;
// - partial state → show a "!" badge and wait for the manual restore (picker / leader `u`);
// - then re-apply focus/collapse (Chrome was seen expanding every group a few seconds after
//   restoring them).
// Idempotence comes from reconcile(): a state that already holds everything plans nothing.

import { log } from '../shared/log';
import { NO_GROUP, isNewTabPageUrl, normalizeTitle, type GroupColor } from '../shared/model';
import { isNearEmpty, readLiveState } from '../shared/live';
import type { ActionResult } from '../shared/messages';
import { planMerges, type DedupeGroup } from '../shared/dedupe';
import { planIsEmpty, reconcile, type RestorePlan, type WindowPlan } from '../shared/reconcile';
import { PINNED_SNAPSHOT_KEY, latestGood, type Snapshot } from '../shared/snapshot';
import { getSettings } from '../shared/settings';
import { focusGroup, getActiveTab, syncFocus } from './focus';
import { groupTabs, scheduleSweepAll } from './grouping';
import { enqueue, sleep } from './queue';
import { getSnapshots, markDirty } from './snapshot';
import { ensureBoot, getPhase, setPhase } from './state';

// --- settle detection ----------------------------------------------------------------------

const SETTLE_MIN_MS = 3_000;
const SETTLE_QUIET_MS = 2_000;
const SETTLE_MAX_MS = 15_000;

let lastActivity = Date.now();

/** Called for every structural tab/group event (not page loads). */
export function noteActivity(): void {
  lastActivity = Date.now();
}

async function waitForSettle(since: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const quiet = now - lastActivity >= SETTLE_QUIET_MS;
    if ((now - since >= SETTLE_MIN_MS && quiet) || now - since >= SETTLE_MAX_MS) return;
    await sleep(250);
  }
}

// --- badge ---------------------------------------------------------------------------------

async function setPendingBadge(plan: RestorePlan | undefined): Promise<void> {
  if (plan && !planIsEmpty(plan)) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setTitle({
      title: `Tab Group Sessions — ${plan.tabCount} tab(s) from the last session are missing. Restore: leader u`,
    });
  } else {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Tab Group Sessions' });
  }
}

// --- boot flow -----------------------------------------------------------------------------

let bootFlowRunning = false;

/**
 * Runs once per browser session (and after an extension reload). Safe to call on every
 * service worker start: it only acts while the phase is not 'ready'.
 */
export async function runBootFlow(): Promise<void> {
  const boot = await ensureBoot();
  if ((await getPhase()) === 'ready' || bootFlowRunning) return;
  bootFlowRunning = true;
  try {
    await setPhase('booting');
    await waitForSettle(boot.at);
    await enqueue('restore.boot', async () => {
      const result = await reconcileNow({ auto: true, trigger: 'boot' });
      log('restore.boot', result);
    });
  } finally {
    await setPhase('ready');
    bootFlowRunning = false;
    void scheduleSweepAll(); // adopt strays that were left alone while booting
    markDirty(); // record the settled (and possibly restored) session
  }
}

/** A window appeared while Chrome was already running (e.g. reopened from the background):
 * if it is the only window and holds almost nothing, restore into it. */
export async function checkNewWindow(): Promise<void> {
  if ((await getPhase()) !== 'ready') return;
  lastActivity = Date.now();
  await waitForSettle(Date.now() - SETTLE_MIN_MS); // just the quiet period
  await enqueue('restore.window', async () => {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (windows.length !== 1) return;
    const result = await reconcileNow({ auto: true, trigger: 'window' });
    log('restore.window', result);
  });
}

interface ReconcileOutcome {
  snapshot?: string;
  nearEmpty?: boolean;
  restored: boolean;
  tabCount: number;
  groupCount: number;
}

/** Must run inside the queue. */
async function reconcileNow(opts: { auto: boolean; trigger: string }): Promise<ReconcileOutcome> {
  const snapshot = latestGood(await getSnapshots());
  // No snapshot is written while booting, so this is the previous session's last good one.
  if (snapshot && opts.trigger === 'boot') await chrome.storage.local.set({ [PINNED_SNAPSHOT_KEY]: snapshot.id });
  const live = await readLiveState();
  if (!snapshot) {
    await applyFocus(undefined);
    return { restored: false, tabCount: 0, groupCount: 0 };
  }
  const plan = reconcile(snapshot.windows, live);
  const nearEmpty = isNearEmpty(live);
  const outcome: ReconcileOutcome = {
    snapshot: new Date(snapshot.ts).toISOString(),
    nearEmpty,
    restored: false,
    tabCount: plan.tabCount,
    groupCount: plan.groupCount,
  };
  if (!planIsEmpty(plan) && opts.auto && nearEmpty) {
    await executePlan(plan, { clearNewTabs: true });
    outcome.restored = true;
    await setPendingBadge(undefined);
  } else if (opts.trigger === 'boot') {
    await setPendingBadge(plan);
  }
  await applyFocus(plan);
  return outcome;
}

/** Manual restore from the picker: merge one snapshot into the current state. */
export async function restoreSnapshot(snapshotId: string): Promise<ActionResult> {
  const snapshot = (await getSnapshots()).find((s: Snapshot) => s.id === snapshotId);
  if (!snapshot) return { ok: false, error: 'Snapshot not found' };
  const plan = reconcile(snapshot.windows, await readLiveState());
  if (planIsEmpty(plan)) {
    await setPendingBadge(undefined);
    return { ok: true };
  }
  await executePlan(plan);
  await setPendingBadge(undefined);
  await applyFocus(plan);
  log('restore.manual', { snapshot: new Date(snapshot.ts).toISOString(), tabs: plan.tabCount, groups: plan.groupCount });
  return { ok: true };
}

// --- execution -----------------------------------------------------------------------------

async function createTab(windowId: number, url: string, pinned = false): Promise<number | undefined> {
  try {
    const tab = await chrome.tabs.create({ windowId, url, active: false, pinned });
    return tab.id;
  } catch (err) {
    // Some URLs can't be opened by extensions (e.g. file:// without access); skip them.
    log('restore.tab.skipped', { url, error: String(err) });
    return undefined;
  }
}

async function createTabs(windowId: number, urls: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const url of urls) {
    const id = await createTab(windowId, url);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

const COMMIT_TIMEOUT_MS = 5_000;

/**
 * Discarding a tab before its URL is committed replaces it with a tab that has NO URL (seen in
 * the M6 test: 9 of 15 restored tabs came back blank). Wait until the navigation has committed
 * (`url` set, no `pendingUrl`), then discard.
 */
async function discardWhenCommitted(tabId: number): Promise<void> {
  const deadline = Date.now() + COMMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return;
    if (tab.url && !tab.pendingUrl) {
      if (!tab.active) await chrome.tabs.discard(tabId).catch(() => undefined);
      return;
    }
    await sleep(100);
  }
  // Not committed in time: leave it loading rather than risk losing the URL.
}

async function executeWindow(wp: WindowPlan, discard: boolean, clearNewTabs: boolean): Promise<void> {
  let placeholder: number | undefined;
  if (wp.windowId === undefined) {
    const win = await chrome.windows.create({ focused: false });
    if (win?.id === undefined) return;
    wp.windowId = win.id;
    placeholder = win.tabs?.[0]?.id; // the New Tab a fresh window starts with
  }
  const windowId = wp.windowId;
  const created: number[] = [];

  for (const t of wp.pinned) {
    const id = await createTab(windowId, t.url, true);
    if (id !== undefined) created.push(id);
  }
  for (const add of wp.addToGroups) {
    const ids = await createTabs(windowId, add.tabs.map((t) => t.url));
    if (ids.length) await groupTabs(ids, { groupId: add.groupId });
    created.push(...ids);
  }
  for (const g of wp.createGroups) {
    const ids = await createTabs(windowId, g.tabs.map((t) => t.url));
    if (!ids.length) continue;
    const groupId = await groupTabs(ids, { windowId });
    await chrome.tabGroups.update(groupId, {
      title: g.title || undefined,
      color: g.color as GroupColor,
      collapsed: true,
    });
    created.push(...ids);
  }
  if (placeholder !== undefined && created.length > 0) await chrome.tabs.remove(placeholder).catch(() => undefined);
  if (clearNewTabs && created.length > 0) {
    // Auto-restore into a near-empty window: the New Tab Chrome opened at startup is noise.
    const leftovers = (await chrome.tabs.query({ windowId })).filter(
      (t) => t.id !== undefined && !created.includes(t.id) && isNewTabPageUrl(t.pendingUrl || t.url),
    );
    if (leftovers.length) await chrome.tabs.remove(leftovers.map((t) => t.id!)).catch(() => undefined);
  }
  if (discard) await Promise.all(created.map(discardWhenCommitted));
}

async function executePlan(plan: RestorePlan, opts: { clearNewTabs?: boolean } = {}): Promise<void> {
  const { discardOnRestore } = await getSettings();
  for (const wp of plan.windows) {
    if (wp.createGroups.length || wp.addToGroups.length || wp.pinned.length)
      await executeWindow(wp, discardOnRestore, opts.clearNewTabs ?? false);
  }
}

/**
 * Re-applies the one-expanded-group rule everywhere. Chrome's restored active tab wins when it
 * is in a group (Chrome's state is newer than the snapshot); otherwise the snapshot's active
 * group is focused.
 */
async function applyFocus(plan: RestorePlan | undefined): Promise<void> {
  const planned = new Map((plan?.windows ?? []).filter((w) => w.windowId !== undefined).map((w) => [w.windowId!, w]));
  for (const win of await chrome.windows.getAll({ windowTypes: ['normal'] })) {
    if (win.id === undefined) continue;
    const active = await getActiveTab(win.id);
    const wanted = planned.get(win.id)?.activeGroup;
    if ((!active || active.pinned || active.groupId === NO_GROUP) && wanted) {
      const key = normalizeTitle(wanted).toLowerCase();
      const target = (await chrome.tabGroups.query({ windowId: win.id })).find(
        (g) => normalizeTitle(g.title ?? '').toLowerCase() === key,
      );
      if (target) {
        await focusGroup(win.id, target.id);
        continue;
      }
    }
    await syncFocus(win.id);
  }
}

// --- duplicate groups ----------------------------------------------------------------------

const DEDUPE_WINDOW_MS = 10 * 60_000;
const BURST_GAP_MS = 1_000;
const groupCreations = new Map<number, number[]>();
let dedupeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Several groups created within a second after boot means a bulk restore (e.g. the user
 * clicked Chrome's own "Restore" after we already restored). Merge same-named groups then.
 * A single group created by hand never triggers this, so typing a name can't cause a merge.
 */
export function noteGroupCreated(group: chrome.tabGroups.TabGroup): void {
  const now = Date.now();
  const times = (groupCreations.get(group.windowId) ?? []).filter((t) => now - t < BURST_GAP_MS);
  times.push(now);
  groupCreations.set(group.windowId, times);
  if (times.length < 2) return;
  void ensureBoot().then(async (boot) => {
    if (now - boot.at > DEDUPE_WINDOW_MS || (await getPhase()) !== 'ready') return;
    clearTimeout(dedupeTimer);
    dedupeTimer = setTimeout(
      () => void enqueue('restore.dedupe', async () => void (await mergeDuplicateGroups(group.windowId, 'push'))),
      SETTLE_QUIET_MS,
    );
  });
}

async function readGroups(): Promise<DedupeGroup[]> {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  return (await chrome.tabGroups.query({})).map((g) => {
    const members = tabs.filter((t) => t.groupId === g.id && t.id !== undefined).sort((a, b) => a.index - b.index);
    return {
      id: g.id,
      windowId: g.windowId,
      title: g.title ?? '',
      index: members[0]?.index ?? 0,
      tabs: members.map((t) => ({ id: t.id!, url: t.url || t.pendingUrl || '' })),
    };
  });
}

/**
 * Merges same-named groups (see shared/dedupe.ts). `pull` (manual): inside `windowId`, then
 * same-named groups of other windows into it. `push` (after a bulk restore into `windowId`):
 * inside it, then its groups that duplicate another window's group into that group.
 * Returns how many groups were merged.
 */
export async function mergeDuplicateGroups(windowId: number, kind: 'pull' | 'push' = 'pull'): Promise<number> {
  const merges = planMerges(await readGroups(), { kind, windowId });
  const touched = new Set<number>();
  for (const m of merges) {
    if (m.move.length) {
      if (m.fromWindowId !== m.intoWindowId) await chrome.tabs.move(m.move, { windowId: m.intoWindowId, index: -1 });
      await groupTabs(m.move, { groupId: m.into });
    }
    if (m.close.length) await chrome.tabs.remove(m.close);
    touched.add(m.fromWindowId).add(m.intoWindowId);
  }
  for (const id of touched) await syncFocus(id); // a source window may be gone by now: no-op
  if (merges.length) log('restore.dedupe', { windowId, kind, merges: merges.map(({ from, into, move, close }) => ({ from, into, moved: move.length, closed: close.length })) });
  return merges.length;
}
