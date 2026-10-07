// Diagnostics page: shows the persisted event log and snapshots, runs the M0 probes.
// Keyboard only: p = probes, d = dump state, c = copy log, r = refresh, x = clear,
// n = snapshot now, v = view latest snapshot.

import { clearLog, readLog, type LogEntry } from '../shared/log';
import { send } from '../shared/messages';
import { SNAPSHOTS_KEY, type Snapshot } from '../shared/snapshot';

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
    const commands = (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut }));
    const report = { build: __BUILD_TIME__, commands, log: await readLog() };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 1));
    status.textContent = 'Log copied to clipboard';
  },
  async r() {
    await renderLog();
  },
  async x() {
    await clearLog();
    await renderLog();
  },
  async n() {
    const snap = await send<Snapshot | undefined>({ type: 'capture-snapshot' });
    status.textContent = snap ? `Snapshot saved (${snap.tabCount} tabs)` : 'Nothing saved (unchanged, or no window)';
  },
  async v() {
    output.textContent = JSON.stringify((await readSnapshots())[0] ?? null, null, 2);
  },
};

async function readSnapshots(): Promise<Snapshot[]> {
  return ((await chrome.storage.local.get(SNAPSHOTS_KEY))[SNAPSHOTS_KEY] as Snapshot[] | undefined) ?? [];
}

async function renderSnapshots() {
  const lines = (await readSnapshots()).map((s) => {
    const groups = s.windows.reduce((n, w) => n + w.groups.length, 0);
    const flag = s.suspicious ? '  SUSPICIOUS' : '';
    return `${new Date(s.ts).toLocaleString('en-GB')}  ${s.tabCount} tabs · ${groups} groups · ${s.windows.length} window(s)${flag}`;
  });
  $<HTMLPreElement>('snapshots').textContent = lines.join('\n') || '(none yet)';
}

const buttons: Record<string, string> = { probes: 'p', dump: 'd', copy: 'c', refresh: 'r', clear: 'x', snapNow: 'n', snapView: 'v' };
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

async function renderCommands() {
  const commands = await chrome.commands.getAll();
  const lines = commands.map((c) => `${(c.shortcut || '(unbound)').padEnd(16)} ${c.name}`);
  $<HTMLPreElement>('commands').textContent = [`build ${__BUILD_TIME__}`, ...lines].join('\n');
}

chrome.storage.local.onChanged.addListener(() => {
  void renderLog();
  void renderSnapshots();
});
void renderSnapshots();
void renderCommands();
void renderLog();
