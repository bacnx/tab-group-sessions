// Serial async queue. Every event handler and action goes through here so operations never
// interleave; combined with idempotent operations this is what prevents event loops.

import { log } from '../shared/log';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// While the mouse button is down on the tab strip (a click is a potential drag), Chrome
// rejects tab/group edits with this error. Observed when clicking a tab in another group.
const TAB_EDIT_BLOCKED = 'Tabs cannot be edited right now';
const RETRY_DELAYS_MS = [50, 100, 200, 300, 500, 750, 1000, 1000, 1000];

function isTabEditBlocked(err: unknown): boolean {
  return String(err).includes(TAB_EDIT_BLOCKED);
}

let tail: Promise<void> = Promise.resolve();

/**
 * Runs `task` after every previously queued task. A task blocked by a tab drag is retried
 * as a whole — safe because tasks re-read state and are idempotent. Retries are scheduled
 * outside the queue so a long drag never blocks other work.
 */
export function enqueue(label: string, task: () => Promise<void>, attempt = 0): Promise<void> {
  const run = tail.then(task).catch((err: unknown) => {
    const delay = RETRY_DELAYS_MS[attempt];
    if (isTabEditBlocked(err) && delay !== undefined) {
      setTimeout(() => void enqueue(label, task, attempt + 1), delay);
      return;
    }
    log('queue.error', { label, attempt, error: String(err) });
  });
  tail = run;
  return run;
}
