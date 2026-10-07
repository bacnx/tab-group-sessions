// Diagnostics page: shows the persisted event log and runs the M0 probes. Keyboard only:
// p = probes, d = dump state, c = copy log, r = refresh, x = clear.

import { clearLog, readLog, type LogEntry } from '../shared/log';
import { send } from '../shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLDivElement>('status');
const output = $<HTMLPreElement>('output');
const logView = $<HTMLPreElement>('log');

function time(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleTimeString('en-GB')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function isBoot(e: LogEntry): boolean {
  return e.ev === 'sw.start' && (e.data as { freshBoot?: boolean } | undefined)?.freshBoot === true;
}

async function renderLog() {
  const entries = await readLog();
  logView.replaceChildren(
    ...entries.map((e) => {
      const line = document.createElement('div');
      if (isBoot(e)) line.className = 'boot';
      line.textContent = `${time(e.t)}  ${e.ev}  ${e.data === undefined ? '' : JSON.stringify(e.data)}`;
      return line;
    }),
  );
  status.textContent = `${entries.length} log entries`;
}

const actions: Record<string, () => Promise<void>> = {
  async p() {
    status.textContent = 'Running probes (a temporary window will open)…';
    const results = await send({ type: 'run-probes' });
    output.textContent = JSON.stringify(results, null, 2);
    await renderLog();
  },
  async d() {
    output.textContent = JSON.stringify(await send({ type: 'dump-state' }), null, 2);
  },
  async c() {
    await navigator.clipboard.writeText(JSON.stringify(await readLog(), null, 1));
    status.textContent = 'Log copied to clipboard';
  },
  async r() {
    await renderLog();
  },
  async x() {
    await clearLog();
    await renderLog();
  },
};

const buttons: Record<string, string> = { probes: 'p', dump: 'd', copy: 'c', refresh: 'r', clear: 'x' };
for (const [id, key] of Object.entries(buttons)) {
  $(id).addEventListener('click', () => void actions[key]?.());
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const action = actions[e.key];
  if (action) {
    e.preventDefault();
    void action();
  }
});

chrome.storage.local.onChanged.addListener(() => void renderLog());
void renderLog();
