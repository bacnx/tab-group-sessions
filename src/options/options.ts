// Options page — fully keyboard operable (native checkbox / button semantics).

import { getSettings, updateSettings, type Settings } from '../shared/settings';

const leader = document.getElementById('leaderEnabled') as HTMLInputElement;
const status = document.getElementById('status') as HTMLParagraphElement;

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
const numberFields: NumberKey[] = ['snapshotCount', 'snapshotDelaySec'];

async function main(): Promise<void> {
  const settings = await getSettings();
  leader.checked = settings.leaderEnabled;
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

document.getElementById('shortcuts')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

void main();
