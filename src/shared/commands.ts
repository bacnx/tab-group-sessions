// Keyboard command names — single source of truth, mirrored by static/manifest.json
// (a unit test keeps them in sync).
//
// Chrome lists commands on chrome://extensions/shortcuts sorted by *name*, not manifest order,
// so names carry a numeric prefix that groups them:
//   1x picker · 2x groups · 3x tabs in group · 4x goto tab N · 5x recovery · 9x debug
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
  nextTabInGroup: '30-next-tab-in-group',
  prevTabInGroup: '31-prev-tab-in-group',
  openDiagnostics: '90-open-diagnostics',
} as const;

const GOTO_TAB = /^4([1-9])-goto-tab-\1$/;

export function gotoTabCommand(n: number): string {
  return `4${n}-goto-tab-${n}`;
}

/** N for a goto-tab command name, else undefined. */
export function parseGotoTab(command: string): number | undefined {
  const m = GOTO_TAB.exec(command);
  return m ? Number(m[1]) : undefined;
}

export function allCommandNames(): string[] {
  return ['_execute_action', ...Object.values(CMD), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(gotoTabCommand)];
}
