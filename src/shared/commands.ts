// Keyboard command names — single source of truth, mirrored by static/manifest.json
// (a unit test keeps them in sync).
//
// Chrome lists commands on chrome://extensions/shortcuts sorted by *name*, not manifest order,
// so names carry a numeric prefix that groups them:
//   1x picker · 2x groups · 3x tabs in group · 4x goto tab N · 9x debug
// Descriptions start with the same category word. Renaming a command drops the user's binding
// for it, so keep these stable once assigned.

export const CMD = {
  openPicker: '10-open-picker',
  openPickerWindow: '11-open-picker-window',
  nextGroup: '20-next-group',
  prevGroup: '21-prev-group',
  lastGroup: '22-last-group',
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
