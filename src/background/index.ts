// Service worker entry. Every listener is registered synchronously at top level (MV3
// requirement); handlers only enqueue work, they never touch state directly.

import './diag';
import { activateTab, focusGroupById, handleGroupRemoved } from './actions';
import { handleCommand } from './commands';
import { syncFocus } from './focus';
import { recordFocusChange, recordNewTab, scheduleSweep, scheduleSweepAll } from './grouping';
import { forgetPickerWindow } from './launcher';
import { enqueue } from './queue';
import type { Message } from '../shared/messages';
import { NO_GROUP } from '../shared/model';
import { clearWindowState } from './state';

chrome.tabs.onActivated.addListener(({ windowId }) => {
  void enqueue('tabs.onActivated', () => syncFocus(windowId));
});

chrome.tabs.onCreated.addListener((tab) => {
  recordNewTab(tab);
  scheduleSweep(tab.windowId);
});

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  // The active tab changed group (moved into a group, or its group was created).
  if (change.groupId !== undefined && tab.active) {
    void enqueue('tabs.onUpdated.groupId', () => syncFocus(tab.windowId));
  }
  // A tab left its group (dragged out, or about to close) or got unpinned.
  if (change.groupId === NO_GROUP || change.pinned === false) scheduleSweep(tab.windowId);
});

chrome.tabs.onAttached.addListener((_tabId, { newWindowId }) => scheduleSweep(newWindowId));

// Keep Inbox last when groups appear or move.
chrome.tabGroups.onCreated.addListener((group) => scheduleSweep(group.windowId));
chrome.tabGroups.onMoved.addListener((group) => scheduleSweep(group.windowId));

chrome.tabGroups.onRemoved.addListener((group) => {
  void enqueue('tabGroups.onRemoved', () => handleGroupRemoved(group));
});

chrome.windows.onFocusChanged.addListener(recordFocusChange);

chrome.windows.onCreated.addListener((win) => {
  if (win.id !== undefined) scheduleSweep(win.id);
});

chrome.windows.onRemoved.addListener((windowId) => {
  void enqueue('windows.onRemoved', async () => {
    await clearWindowState(windowId);
    await forgetPickerWindow(windowId);
  });
});

chrome.commands.onCommand.addListener(handleCommand);

// Picker actions. Answer right away so the picker can close; the work continues in the queue.
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'focus-group':
      void enqueue('picker.focus-group', () => focusGroupById(msg.groupId));
      break;
    case 'activate-tab':
      void enqueue('picker.activate-tab', () => activateTab(msg.tabId));
      break;
    default:
      return false;
  }
  sendResponse(true);
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueue('onInstalled.sync', async () => {
    for (const win of await chrome.windows.getAll({ windowTypes: ['normal'] })) {
      if (win.id !== undefined) await syncFocus(win.id);
    }
  });
  // Adopt the strays that existed before the extension was installed/reloaded.
  void scheduleSweepAll();
});

// Give Chrome's session restore time to finish before adopting strays (proper boot
// detection and reconcile come with M6).
chrome.runtime.onStartup.addListener(() => void scheduleSweepAll(3000));
