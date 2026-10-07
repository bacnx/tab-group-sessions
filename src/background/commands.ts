// chrome.commands → actions. Commands act on the last-focused normal window.

import { CMD, parseGotoTab } from '../shared/commands';
import { cycleGroup, cycleTabInGroup, gotoTabInGroup, lastGroup } from './actions';
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
    case CMD.openPicker:
      void openPicker(tab?.windowId);
      return;
    case CMD.openPickerWindow:
      void openPickerWindow(tab?.windowId);
      return;
    case CMD.openDiagnostics:
      void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
      return;
  }

  void enqueue(`command:${command}`, async () => {
    const windowId = await targetWindowId(tab);
    if (windowId === undefined) return;
    switch (command) {
      case CMD.nextGroup:
        return cycleGroup(windowId, 1);
      case CMD.prevGroup:
        return cycleGroup(windowId, -1);
      case CMD.lastGroup:
        return lastGroup(windowId);
      case CMD.nextTabInGroup:
        return cycleTabInGroup(windowId, 1);
      case CMD.prevTabInGroup:
        return cycleTabInGroup(windowId, -1);
    }
    const n = parseGotoTab(command);
    if (n !== undefined) return gotoTabInGroup(windowId, n);
  });
}
