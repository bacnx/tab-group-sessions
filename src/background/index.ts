// Service worker entry. Every listener is registered synchronously at top level (MV3
// requirement); handlers only enqueue work, they never touch state directly.

import './diag';
import { activateTab, focusGroupById, handleGroupRemoved } from './actions';
import { handleCommand, runCommand } from './commands';
import { syncFocus } from './focus';
import { recordFocusChange, recordNewTab, recordUserInChrome, scheduleSweep, scheduleSweepAll, trackPickerPort } from './grouping';
import { forgetPickerWindow } from './launcher';
import { enqueue } from './queue';
import type { ActionResult, Message } from '../shared/messages';
import { NO_GROUP } from '../shared/model';
import { closeGroup, moveActiveTab, newGroup, renameGroup, setGroupColor } from './manage';
import { checkNewWindow, noteActivity, noteGroupCreated, restoreSnapshot, runBootFlow } from './restore';
import { SNAPSHOT_ALARM, capture, captureIfDirty, markDirty, windowClosing } from './snapshot';
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
chrome.runtime.onConnect.addListener(trackPickerPort);

chrome.windows.onCreated.addListener((win) => {
  if (win.id !== undefined) scheduleSweep(win.id);
});

chrome.windows.onRemoved.addListener((windowId) => {
  void enqueue('windows.onRemoved', async () => {
    await clearWindowState(windowId);
    await forgetPickerWindow(windowId);
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  recordUserInChrome();
  handleCommand(command, tab);
});

/** Runs a validating action in the queue and replies with its result. */
function reply(label: string, action: () => Promise<ActionResult>, sendResponse: (r: ActionResult) => void): true {
  let result: ActionResult = { ok: false, error: 'Chrome is busy, try again' };
  void enqueue(label, async () => {
    result = await action();
  }).then(() => sendResponse(result));
  return true;
}

// Picker actions. Fire-and-forget ones answer right away so the picker can close; the work
// continues in the queue. Validating ones answer with an ActionResult.
chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'focus-group':
      void enqueue('picker.focus-group', () => focusGroupById(msg.groupId));
      break;
    case 'activate-tab':
      void enqueue('picker.activate-tab', () => activateTab(msg.tabId));
      break;
    case 'run-command':
      runCommand(msg.command, msg.windowId);
      break;
    case 'move-tab':
      return reply('picker.move-tab', () => moveActiveTab(msg.windowId, msg.groupId, msg.newTitle), sendResponse);
    case 'new-group':
      return reply('picker.new-group', () => newGroup(msg.windowId, msg.title), sendResponse);
    case 'rename-group':
      return reply('picker.rename-group', () => renameGroup(msg.groupId, msg.title), sendResponse);
    case 'close-group':
      return reply('picker.close-group', () => closeGroup(msg.groupId), sendResponse);
    case 'set-group-color':
      return reply('picker.set-group-color', () => setGroupColor(msg.groupId, msg.color), sendResponse);
    case 'restore-snapshot':
      return reply('picker.restore-snapshot', () => restoreSnapshot(msg.snapshotId), sendResponse);
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

// --- snapshots -----------------------------------------------------------------------------

chrome.tabs.onCreated.addListener(markDirty);
chrome.tabs.onMoved.addListener(markDirty);
chrome.tabs.onAttached.addListener(markDirty);
chrome.tabs.onDetached.addListener(markDirty);
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  // Titles change all the time (notification counters); they are read at capture time anyway.
  if (change.url !== undefined || change.groupId !== undefined || change.pinned !== undefined) markDirty();
});
chrome.tabs.onRemoved.addListener((_tabId, { isWindowClosing }) => {
  if (isWindowClosing) windowClosing();
  else markDirty();
});
chrome.tabGroups.onCreated.addListener(markDirty);
chrome.tabGroups.onUpdated.addListener(markDirty);
chrome.tabGroups.onRemoved.addListener(markDirty);
chrome.tabGroups.onMoved.addListener(markDirty);

// Safety net for a service worker that died before its debounce timer fired.
function ensureSnapshotAlarm(): void {
  void chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(ensureSnapshotAlarm);
chrome.runtime.onStartup.addListener(ensureSnapshotAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SNAPSHOT_ALARM) void enqueue('snapshot.alarm', () => captureIfDirty());
});

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (msg.type !== 'capture-snapshot') return false;
  void enqueue('snapshot.manual', async () => {
    sendResponse(await capture());
  });
  return true;
});

// --- boot / restore ------------------------------------------------------------------------

// Settle detection: structural changes only (page loads don't count).
chrome.tabs.onCreated.addListener(noteActivity);
chrome.tabs.onRemoved.addListener(noteActivity);
chrome.tabs.onMoved.addListener(noteActivity);
chrome.tabs.onAttached.addListener(noteActivity);
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.groupId !== undefined || change.pinned !== undefined) noteActivity();
});
chrome.tabGroups.onCreated.addListener((group) => {
  noteActivity();
  noteGroupCreated(group);
});
chrome.tabGroups.onUpdated.addListener(noteActivity);
chrome.tabGroups.onRemoved.addListener(noteActivity);
chrome.tabGroups.onMoved.addListener(noteActivity);
chrome.windows.onCreated.addListener((win) => {
  noteActivity();
  if (win.type === 'normal') void checkNewWindow();
});

// Every service worker start: a no-op unless this browser session hasn't been reconciled yet.
void runBootFlow();
