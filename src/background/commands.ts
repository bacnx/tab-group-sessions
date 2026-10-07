// chrome.commands → actions. Commands act on the last-focused normal window.

import { cycleGroup, lastGroup } from './actions';
import { isNormalWindow } from './focus';
import { openPicker, openPickerWindow } from './launcher';
import { enqueue } from './queue';

async function targetWindowId(tab: chrome.tabs.Tab | undefined): Promise<number | undefined> {
  if (tab?.windowId !== undefined && (await isNormalWindow(tab.windowId))) return tab.windowId;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  return win?.id;
}

export function handleCommand(command: string, tab: chrome.tabs.Tab | undefined): void {
  // UI launchers run outside the queue: openPopup must be called promptly.
  switch (command) {
    case 'open-picker':
      void openPicker(tab?.windowId);
      return;
    case 'open-picker-window':
      void openPickerWindow(tab?.windowId);
      return;
    case 'open-diagnostics':
      void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
      return;
  }

  void enqueue(`command:${command}`, async () => {
    const windowId = await targetWindowId(tab);
    if (windowId === undefined) return;
    switch (command) {
      case 'next-group':
        return cycleGroup(windowId, 1);
      case 'prev-group':
        return cycleGroup(windowId, -1);
      case 'last-group':
        return lastGroup(windowId);
    }
  });
}
