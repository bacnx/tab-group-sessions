// Serial async queue. Every event handler and action goes through here so operations never
// interleave; combined with idempotent operations this is what prevents event loops.

import { log } from '../shared/log';

let tail: Promise<void> = Promise.resolve();

export function enqueue(label: string, task: () => Promise<void>): Promise<void> {
  const run = tail.then(task).catch((err: unknown) => log('queue.error', { label, error: String(err) }));
  tail = run;
  return run;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
