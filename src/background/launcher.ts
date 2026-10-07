// Opens the picker UI. Primary path: the action popup (works on every page, including
// chrome://, the New Tab page, PDFs and the Web Store). Fallback: a small popup window.

import { log } from '../shared/log';
import { PENDING_OPEN_KEY, type PendingOpen } from '../shared/messages';

const PICKER_WINDOW_KEY = 'pickerWindowId';

/** The normal window the picker acts on, even if the command came from the picker window. */
async function resolveOrigin(windowId: number | undefined): Promise<chrome.windows.Window | undefined> {
  if (windowId !== undefined) {
    const win = await chrome.windows.get(windowId).catch(() => undefined);
    if (win?.type === 'normal') return win;
  }
  return chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
}

export async function openPicker(windowId?: number): Promise<void> {
  const origin = await resolveOrigin(windowId);
  const pending: PendingOpen = { src: 'api', ts: Date.now(), originWindowId: origin?.id };
  await chrome.storage.session.set({ [PENDING_OPEN_KEY]: pending });
  try {
    await chrome.action.openPopup(origin?.id !== undefined ? { windowId: origin.id } : {});
    log('launcher.openPopup.ok', { originWindowId: origin?.id });
  } catch (err) {
    log('launcher.openPopup.error', { originWindowId: origin?.id, error: String(err) });
    await openPickerWindow(origin?.id);
  }
}

const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 440;

export async function openPickerWindow(windowId?: number): Promise<void> {
  // Never stack picker windows: focus the existing one instead.
  const existingId = (await chrome.storage.session.get(PICKER_WINDOW_KEY))[PICKER_WINDOW_KEY] as number | undefined;
  if (existingId !== undefined) {
    const focused = await chrome.windows.update(existingId, { focused: true }).catch(() => undefined);
    if (focused) return;
  }

  const origin = await resolveOrigin(windowId);
  if (origin?.id === undefined) return;
  // Center over the origin window.
  const left = Math.round((origin.left ?? 0) + ((origin.width ?? WINDOW_WIDTH) - WINDOW_WIDTH) / 2);
  const top = Math.round((origin.top ?? 0) + ((origin.height ?? WINDOW_HEIGHT) - WINDOW_HEIGHT) / 3);
  const url = chrome.runtime.getURL(`picker.html?src=window&origin=${origin.id}`);
  const t0 = Date.now();
  const win = await chrome.windows.create({ url, type: 'popup', width: WINDOW_WIDTH, height: WINDOW_HEIGHT, left, top, focused: true });
  await chrome.storage.session.set({ [PICKER_WINDOW_KEY]: win?.id });
  log('launcher.window.created', { originWindowId: origin.id, ms: Date.now() - t0 });
}

/** Call from windows.onRemoved. */
export async function forgetPickerWindow(windowId: number): Promise<void> {
  const existingId = (await chrome.storage.session.get(PICKER_WINDOW_KEY))[PICKER_WINDOW_KEY] as number | undefined;
  if (existingId === windowId) await chrome.storage.session.remove(PICKER_WINDOW_KEY);
}
