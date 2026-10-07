// Snapshot capture: after tab/group changes settle, write the session of every normal window
// to storage.local (ring buffer, newest first). Restore comes in M6.
//
// Never written from a transient state:
// - closing a window first ungroups its tabs, then removes them with isWindowClosing — any
//   pending snapshot is cancelled and writes are suppressed for a moment;
// - with no normal window left (Chrome keeps running in the background) nothing is written;
// - right after a fresh start, while Chrome is still restoring the previous session.

import { log } from '../shared/log';
import {
  buildWindows,
  countTabs,
  hashWindows,
  isSuspicious,
  pushSnapshot,
  SNAPSHOTS_KEY,
  type LiveWindow,
  type Snapshot,
} from '../shared/snapshot';
import { DEFAULT_SETTINGS, getSettings, type Settings } from '../shared/settings';
import { enqueue } from './queue';
import { ensureBoot } from './state';

const DIRTY_KEY = 'snapshotDirty';
export const SNAPSHOT_ALARM = 'snapshot';
/** Until M6's settle detection: no snapshots this long after a fresh start. */
const BOOT_GRACE_MS = 20_000;
const CLOSING_SUPPRESS_MS = 2_000;

let settings: Settings = DEFAULT_SETTINGS;
void getSettings().then((s) => (settings = s));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void getSettings().then((s) => (settings = s));
});

let timer: ReturnType<typeof setTimeout> | undefined;
let suppressUntil = 0;

/** Something changed: write a snapshot once things are quiet. */
export function markDirty(): void {
  void chrome.storage.session.set({ [DIRTY_KEY]: true });
  clearTimeout(timer);
  timer = setTimeout(() => void enqueue('snapshot', () => captureIfDirty()), settings.snapshotDelaySec * 1000);
}

/** A window is closing: drop the pending snapshot, it would capture a half-closed window. The
 * dirty flag stays, so the periodic alarm still records the new state if Chrome keeps running. */
export function windowClosing(): void {
  clearTimeout(timer);
  suppressUntil = Date.now() + CLOSING_SUPPRESS_MS;
}

export async function captureIfDirty(): Promise<void> {
  if (Date.now() < suppressUntil) return;
  const boot = await ensureBoot();
  if (Date.now() - boot.at < BOOT_GRACE_MS) return;
  const dirty = (await chrome.storage.session.get(DIRTY_KEY))[DIRTY_KEY] === true;
  if (!dirty) return;
  await capture();
}

async function readLive(): Promise<LiveWindow[]> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  return windows.map((w) => ({
    focused: w.focused,
    tabs: (w.tabs ?? []).map((t) => ({
      index: t.index,
      url: t.url || t.pendingUrl || '',
      title: t.title ?? '',
      groupId: t.groupId,
      pinned: t.pinned,
      active: t.active,
    })),
    groups: groups
      .filter((g) => g.windowId === w.id)
      .map((g) => ({ id: g.id, title: g.title ?? '', color: g.color, collapsed: g.collapsed })),
  }));
}

export async function getSnapshots(): Promise<Snapshot[]> {
  return ((await chrome.storage.local.get(SNAPSHOTS_KEY))[SNAPSHOTS_KEY] as Snapshot[] | undefined) ?? [];
}

/** Writes a snapshot now (unless nothing would be saved). Returns it, or undefined. */
export async function capture(): Promise<Snapshot | undefined> {
  const windows = buildWindows(await readLive(), chrome.runtime.getURL(''));
  await chrome.storage.session.set({ [DIRTY_KEY]: false });
  if (windows.length === 0) return undefined; // no window left: never save an empty session

  const list = await getSnapshots();
  const tabCount = countTabs(windows);
  const snap: Snapshot = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    hash: hashWindows(windows),
    tabCount,
    suspicious: isSuspicious(list[0], tabCount),
    windows,
  };
  const next = pushSnapshot(list, snap, settings.snapshotCount);
  if (next[0] !== snap) return undefined; // identical to the latest
  await chrome.storage.local.set({ [SNAPSHOTS_KEY]: next });
  log('snapshot.saved', { tabs: tabCount, windows: windows.length, suspicious: snap.suspicious, kept: next.length });
  return snap;
}
