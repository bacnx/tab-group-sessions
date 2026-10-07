// User settings (storage.local). Edited on the options page.

export interface Settings {
  /** `_execute_action` opens the tmux-style leader menu instead of the search picker. */
  leaderEnabled: boolean;
  /** How many snapshots to keep (newest first). */
  snapshotCount: number;
  /** Quiet time after the last tab/group change before a snapshot is written. */
  snapshotDelaySec: number;
  /** Restored tabs are discarded right away so they don't all load at once. */
  discardOnRestore: boolean;
}

export const DEFAULT_SETTINGS: Settings = { leaderEnabled: true, snapshotCount: 10, snapshotDelaySec: 3, discardOnRestore: true };

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
