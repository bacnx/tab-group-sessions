// User settings (storage.local). Edited on the options page.

export interface Settings {
  /** `_execute_action` opens the tmux-style leader menu instead of the search picker. */
  leaderEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = { leaderEnabled: true };

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
