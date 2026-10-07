// Typed wrappers over chrome.storage. Per-window, per-browser-session state lives in
// storage.session (cleared on restart, survives service worker restarts).

const mruKey = (windowId: number) => `mru:${windowId}`;

/** Group ids of a window, most recently focused first. */
export async function getMru(windowId: number): Promise<number[]> {
  const key = mruKey(windowId);
  return ((await chrome.storage.session.get(key))[key] as number[] | undefined) ?? [];
}

export async function setMru(windowId: number, mru: number[]): Promise<void> {
  await chrome.storage.session.set({ [mruKey(windowId)]: mru });
}

export async function clearWindowState(windowId: number): Promise<void> {
  await chrome.storage.session.remove(mruKey(windowId));
}
