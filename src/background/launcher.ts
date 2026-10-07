// Opens the picker UI. Primary path: the action popup (works on every page, including
// chrome://, the New Tab page, PDFs and the Web Store). Fallback: a small popup window.

import { log } from '../shared/log';
import { PENDING_OPEN_KEY, type PendingOpen } from '../shared/messages';

export async function openPicker(originWindowId?: number): Promise<void> {
  const pending: PendingOpen = { src: 'api', ts: Date.now(), originWindowId };
  await chrome.storage.session.set({ [PENDING_OPEN_KEY]: pending });
  try {
    await chrome.action.openPopup(originWindowId !== undefined ? { windowId: originWindowId } : {});
    log('launcher.openPopup.ok', { originWindowId });
  } catch (err) {
    log('launcher.openPopup.error', { originWindowId, error: String(err) });
    await openPickerWindow(originWindowId);
  }
}

const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 440;

export async function openPickerWindow(originWindowId?: number): Promise<void> {
  const origin =
    originWindowId !== undefined
      ? await chrome.windows.get(originWindowId)
      : await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  // Center over the origin window.
  const left = Math.round((origin.left ?? 0) + ((origin.width ?? WINDOW_WIDTH) - WINDOW_WIDTH) / 2);
  const top = Math.round((origin.top ?? 0) + ((origin.height ?? WINDOW_HEIGHT) - WINDOW_HEIGHT) / 3);
  const url = chrome.runtime.getURL(`picker.html?src=window&origin=${origin.id}`);
  const t0 = Date.now();
  await chrome.windows.create({ url, type: 'popup', width: WINDOW_WIDTH, height: WINDOW_HEIGHT, left, top, focused: true });
  log('launcher.window.created', { originWindowId: origin.id, ms: Date.now() - t0 });
}
