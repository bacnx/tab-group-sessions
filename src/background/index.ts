// Service worker entry. Every listener is registered synchronously at top level (MV3
// requirement); handlers only enqueue work, they never touch state directly.

import './diag';
import { handleGroupRemoved } from './actions';
import { handleCommand } from './commands';
import { syncFocus } from './focus';
import { forgetPickerWindow } from './launcher';
import { enqueue } from './queue';
import { clearWindowState } from './state';

chrome.tabs.onActivated.addListener(({ windowId }) => {
  void enqueue('tabs.onActivated', () => syncFocus(windowId));
});

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  // The active tab changed group (moved into a group, or its group was created).
  if (change.groupId !== undefined && tab.active) {
    void enqueue('tabs.onUpdated.groupId', () => syncFocus(tab.windowId));
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  void enqueue('tabGroups.onRemoved', () => handleGroupRemoved(group));
});

chrome.windows.onRemoved.addListener((windowId) => {
  void enqueue('windows.onRemoved', async () => {
    await clearWindowState(windowId);
    await forgetPickerWindow(windowId);
  });
});

chrome.commands.onCommand.addListener(handleCommand);

chrome.runtime.onInstalled.addListener(() => {
  void enqueue('onInstalled.sync', async () => {
    for (const win of await chrome.windows.getAll({ windowTypes: ['normal'] })) {
      if (win.id !== undefined) await syncFocus(win.id);
    }
  });
});
