// Message protocol between extension pages and the service worker.

import type { GroupColor } from './model';

export type Message =
  | { type: 'diag-log'; ev: string; data?: unknown }
  | { type: 'run-probes' }
  | { type: 'dump-state' }
  | { type: 'capture-snapshot' }
  | { type: 'focus-group'; groupId: number }
  | { type: 'activate-tab'; tabId: number }
  | { type: 'run-command'; command: string; windowId: number }
  | { type: 'move-tab'; windowId: number; groupId?: number; newTitle?: string }
  | { type: 'new-group'; windowId: number; title: string }
  | { type: 'rename-group'; groupId: number; title: string }
  | { type: 'close-group'; groupId: number }
  | { type: 'set-group-color'; groupId: number; color: GroupColor };

/** Reply to mutating picker messages. */
export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function send<T = unknown>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** storage.session key: tells the picker how/why it was opened (set right before openPopup). */
export const PENDING_OPEN_KEY = 'pendingOpen';

export type PickerMode = 'leader' | 'search' | 'move' | 'new-group' | 'rename' | 'close' | 'color';

export interface PendingOpen {
  src: 'api' | 'window';
  ts: number;
  mode: PickerMode;
  originWindowId?: number;
}
