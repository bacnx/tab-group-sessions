// Keyboard commands (and the same actions run from the leader menu) → actions.
// Commands act on the last-focused normal window.

import { CMD, parseGotoTab } from '../shared/commands';
import type { PickerMode } from '../shared/messages';
import { cycleGroup, cycleTabInGroup, gotoTabInGroup, lastGroup } from './actions';
import { isNormalWindow } from './focus';
import { openPicker, openPickerWindow } from './launcher';
import { moveCurrentGroup, reopenClosedGroup } from './manage';
import { enqueue } from './queue';
import { mergeDuplicateGroups } from './restore';

async function targetWindowId(hint: number | undefined): Promise<number | undefined> {
  if (hint !== undefined && (await isNormalWindow(hint))) return hint;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  return win?.id;
}

/** Commands that only open the picker in a given mode. */
const PICKER_COMMANDS: Record<string, PickerMode> = {
  [CMD.openPicker]: 'search',
  [CMD.openLeader]: 'leader',
  [CMD.moveTab]: 'move',
  [CMD.newGroup]: 'new-group',
  [CMD.renameGroup]: 'rename',
  [CMD.closeGroup]: 'close',
  [CMD.setGroupColor]: 'color',
  [CMD.restoreSnapshot]: 'snapshots',
};

export function runCommand(command: string, windowHint?: number): void {
  // UI launchers run outside the queue: the picker should appear immediately.
  const mode = PICKER_COMMANDS[command];
  if (mode) {
    void openPicker(windowHint, mode);
    return;
  }
  switch (command) {
    case CMD.openPickerWindow:
      void openPickerWindow(windowHint, 'search');
      return;
    case CMD.openDiagnostics:
      void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
      return;
  }

  void enqueue(`command:${command}`, async () => {
    const windowId = await targetWindowId(windowHint);
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
      case CMD.moveGroupLeft:
        return moveCurrentGroup(windowId, -1);
      case CMD.moveGroupRight:
        return moveCurrentGroup(windowId, 1);
      case CMD.mergeDuplicateGroups:
        return void (await mergeDuplicateGroups(windowId));
      case CMD.reopenClosedGroup:
        return reopenClosedGroup(windowId);
    }
    const n = parseGotoTab(command);
    if (n !== undefined) return gotoTabInGroup(windowId, n);
  });
}

export function handleCommand(command: string, tab: chrome.tabs.Tab | undefined): void {
  runCommand(command, tab?.windowId);
}
