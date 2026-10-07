// Options page — fully keyboard operable (native checkbox / button semantics).

import { getSettings, updateSettings } from '../shared/settings';

const leader = document.getElementById('leaderEnabled') as HTMLInputElement;
const status = document.getElementById('status') as HTMLParagraphElement;

async function main(): Promise<void> {
  leader.checked = (await getSettings()).leaderEnabled;
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
