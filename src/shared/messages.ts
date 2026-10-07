// Message protocol between extension pages and the service worker.

export type Message =
  | { type: 'diag-log'; ev: string; data?: unknown }
  | { type: 'run-probes' }
  | { type: 'dump-state' };

export async function send<T = unknown>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/** storage.session key: tells the picker how/why it was opened (set right before openPopup). */
export const PENDING_OPEN_KEY = 'pendingOpen';

export interface PendingOpen {
  src: 'api' | 'window';
  ts: number;
  originWindowId?: number;
}
