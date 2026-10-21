// Keyboard command names — single source of truth, mirrored by static/manifest.json
// (a unit test keeps them in sync).
//
// Chrome lists commands on chrome://extensions/shortcuts sorted by *name*, not manifest order,
// so names carry a numeric prefix that groups them:
//   1x picker · 2x groups · 3x tabs in group · 4x goto tab N · 5x recovery · 6x focus group N
//   · 9x debug
// Descriptions start with the same category word. Renaming a command drops the user's binding
// for it, so keep these stable once assigned.

export const CMD = {
  openPicker: '10-open-picker',
  openPickerWindow: '11-open-picker-window',
  openLeader: '12-open-leader',
  nextGroup: '20-next-group',
  prevGroup: '21-prev-group',
  lastGroup: '22-last-group',
  moveTab: '23-move-tab',
  newGroup: '24-new-group',
  renameGroup: '25-rename-group',
  closeGroup: '26-close-group',
  setGroupColor: '27-set-group-color',
  moveGroupLeft: '28-move-group-left',
  moveGroupRight: '29-move-group-right',
  restoreSnapshot: '50-restore-snapshot',
  mergeDuplicateGroups: '51-merge-duplicate-groups',
  reopenClosedGroup: '52-reopen-closed-group',
  nextTabInGroup: '30-next-tab-in-group',
  prevTabInGroup: '31-prev-tab-in-group',
  focusInbox: '60-focus-inbox',
  openDiagnostics: '90-open-diagnostics',
} as const;

/**
 * The agreed default layout. Chrome applies at most 4 `suggested_key`s, and only on the first
 * install, so the manifest carries the first four (marked `suggested`) and the rest are bound
 * by hand; the Options page compares this table with the live bindings.
 * Keys are in manifest syntax (`Alt+Period`).
 */
export const RECOMMENDED_KEYS: readonly { command: string; key: string; suggested?: boolean }[] = [
  { command: '_execute_action', key: 'Alt+A', suggested: true },
  { command: CMD.openPicker, key: 'Alt+S', suggested: true },
  { command: CMD.nextGroup, key: 'Alt+Period', suggested: true },
  { command: CMD.prevGroup, key: 'Alt+Comma', suggested: true },
  { command: CMD.lastGroup, key: 'Alt+L' },
  { command: CMD.moveTab, key: 'Alt+M' },
  { command: CMD.newGroup, key: 'Alt+C' },
  { command: CMD.closeGroup, key: 'Alt+X' },
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ command: focusGroupCommand(n), key: `Alt+${n}` })),
  { command: CMD.openDiagnostics, key: 'Alt+Shift+D' },
];

/** Canonical form for comparing a manifest key with what chrome.commands reports
 * (which may use `.`/`,` and other spellings). */
export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .map((part) => ({ period: '.', comma: ',', command: 'cmd', '⌘': 'cmd', '⌥': 'alt', '⇧': 'shift', '⌃': 'macctrl' })[part] ?? part)
    .sort()
    .join('+');
}

const GOTO_TAB = /^4([1-9])-goto-tab-\1$/;

export function gotoTabCommand(n: number): string {
  return `4${n}-goto-tab-${n}`;
}

/** N for a goto-tab command name, else undefined. */
export function parseGotoTab(command: string): number | undefined {
  const m = GOTO_TAB.exec(command);
  return m ? Number(m[1]) : undefined;
}

const FOCUS_GROUP = /^6([1-9])-focus-group-\1$/;

/** focus-group-N: 0 is the Inbox, 1–9 the other groups from the left (see numberGroups). */
export function focusGroupCommand(n: number): string {
  return n === 0 ? CMD.focusInbox : `6${n}-focus-group-${n}`;
}

/** N for a focus-group command name (0 = Inbox), else undefined. */
export function parseFocusGroup(command: string): number | undefined {
  if (command === CMD.focusInbox) return 0;
  const m = FOCUS_GROUP.exec(command);
  return m ? Number(m[1]) : undefined;
}

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function allCommandNames(): string[] {
  return ['_execute_action', ...Object.values(CMD), ...DIGITS.map(gotoTabCommand), ...DIGITS.map((n) => focusGroupCommand(n))];
}
