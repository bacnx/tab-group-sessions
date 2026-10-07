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

// --- boot -----------------------------------------------------------------------------------

const BOOT_KEY = 'boot';

export interface Boot {
  id: string;
  /** When this browser session (or extension reload) started, as seen by the extension. */
  at: number;
  /** True for the service worker start that created the boot record. */
  fresh: boolean;
}

let bootPromise: Promise<Boot> | undefined;

/**
 * storage.session is wiped on browser restart and on extension reload/update, so a missing
 * boot record means "fresh start". Memoised per service worker lifetime.
 */
export function ensureBoot(): Promise<Boot> {
  bootPromise ??= (async () => {
    const stored = (await chrome.storage.session.get(BOOT_KEY))[BOOT_KEY] as Omit<Boot, 'fresh'> | undefined;
    if (stored) return { ...stored, fresh: false };
    const boot = { id: crypto.randomUUID(), at: Date.now() };
    await chrome.storage.session.set({ [BOOT_KEY]: boot });
    return { ...boot, fresh: true };
  })();
  return bootPromise;
}

// --- boot phase -----------------------------------------------------------------------------

const PHASE_KEY = 'phase';

/** 'booting' until Chrome's own session restore has settled and restore.ts has reconciled. */
export type Phase = 'booting' | 'ready';

export async function getPhase(): Promise<Phase | undefined> {
  return (await chrome.storage.session.get(PHASE_KEY))[PHASE_KEY] as Phase | undefined;
}

export async function setPhase(phase: Phase): Promise<void> {
  await chrome.storage.session.set({ [PHASE_KEY]: phase });
}

export async function isReady(): Promise<boolean> {
  return (await getPhase()) === 'ready';
}
