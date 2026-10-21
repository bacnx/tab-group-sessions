// Options page — fully keyboard operable (native checkbox / button semantics).

import { RECOMMENDED_KEYS, normalizeShortcut } from '../shared/commands';
import { getSettings, updateSettings, type Settings } from '../shared/settings';

const leader = document.getElementById('leaderEnabled') as HTMLInputElement;
const discard = document.getElementById('discardOnRestore') as HTMLInputElement;
const status = document.getElementById('status') as HTMLParagraphElement;

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
const numberFields: NumberKey[] = ['snapshotCount', 'snapshotDelaySec'];

async function main(): Promise<void> {
  const settings = await getSettings();
  leader.checked = settings.leaderEnabled;
  discard.checked = settings.discardOnRestore;
  for (const key of numberFields) {
    const input = document.getElementById(key) as HTMLInputElement;
    input.value = String(settings[key]);
    input.addEventListener('change', async () => {
      const min = Number(input.min);
      const max = Number(input.max);
      const value = Math.round(Math.min(max, Math.max(min, Number(input.value) || min)));
      input.value = String(value);
      await updateSettings({ [key]: value });
      status.textContent = 'Saved.';
    });
  }
  leader.focus();
}

leader.addEventListener('change', async () => {
  await updateSettings({ leaderEnabled: leader.checked });
  status.textContent = 'Saved.';
});

discard.addEventListener('change', async () => {
  await updateSettings({ discardOnRestore: discard.checked });
  status.textContent = 'Saved.';
});

document.getElementById('shortcuts')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

/** `Alt+Period` → `Alt+.` for display. */
const displayKey = (key: string) => key.replace(/\bPeriod\b/, '.').replace(/\bComma\b/, ',');

async function renderKeys(): Promise<void> {
  const live = new Map((await chrome.commands.getAll()).map((c) => [c.name ?? '', c]));
  const rows = RECOMMENDED_KEYS.map(({ command, key }) => {
    const current = live.get(command)?.shortcut ?? '';
    const state = !current ? 'unbound' : normalizeShortcut(current) === normalizeShortcut(key) ? 'ok' : 'differs';
    const tr = document.createElement('tr');
    tr.className = state;
    const description = command === '_execute_action' ? 'Picker · Leader menu' : (live.get(command)?.description ?? command);
    for (const text of [description, displayKey(key), current || 'not bound']) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  });
  document.querySelector('#keys tbody')!.replaceChildren(...rows);
}

// Coming back from chrome://extensions/shortcuts: show the new bindings.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void renderKeys();
});

void main();
void renderKeys();
