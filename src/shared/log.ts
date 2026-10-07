// Persistent diagnostic log (storage.local ring buffer) so event order survives a browser
// restart. Only the service worker writes; other pages send a 'diag-log' message instead,
// which keeps writes serialised in a single context.

export interface LogEntry {
  t: number;
  ev: string;
  data?: unknown;
}

export const LOG_KEY = 'diagLog';
const MAX_ENTRIES = 2000;

let pending: LogEntry[] = [];
let chain: Promise<void> = Promise.resolve();

export function log(ev: string, data?: unknown): void {
  const entry: LogEntry = { t: Date.now(), ev, data };
  console.debug('[tgs]', ev, data ?? '');
  pending.push(entry);
  chain = chain.then(flush, flush);
}

async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const stored = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] as LogEntry[] | undefined;
  const next = (stored ?? []).concat(batch).slice(-MAX_ENTRIES);
  await chrome.storage.local.set({ [LOG_KEY]: next });
}

export async function readLog(): Promise<LogEntry[]> {
  const stored = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] as LogEntry[] | undefined;
  return stored ?? [];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.remove(LOG_KEY);
}
