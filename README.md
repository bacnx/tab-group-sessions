# Tab Group Sessions

A personal Chrome extension that turns Tab Groups into tmux-like sessions. Each task gets one
group, only the focused group is expanded, and you can manage tabs, groups and windows from the
keyboard alone.

It is unpacked and never published. It targets Chrome 154 on Windows; Mac and Linux should
work but are untested. Design notes and verified Chrome behaviour are in [CLAUDE.md](CLAUDE.md).

## Install

Requires Node.js with corepack. The repo pins its pnpm version.

```bash
corepack enable
pnpm install
pnpm build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. Bind keys at `chrome://extensions/shortcuts`. Most commands ship unbound, see below.
4. Recommended: set `chrome://settings/onStartup` to **Continue where you left off**. The
   extension's restore only adds what Chrome itself did not bring back.

After rebuilding, press the reload button on the extension card. Pages like the picker and
diagnostics pick up new files on their own, but the service worker and manifest only update on
reload. `pnpm dev` rebuilds on every change.

## How it behaves

- **One open group per window.** The focused group is always the group of the active tab.
  Switching groups by any route (picker, shortcut, Ctrl+Tab, clicking a tab) collapses the
  others.
- **New tabs** from Ctrl+T, links or bookmarks go to the end of the current group.
- **Inbox.** Tabs opened from other apps, and ungrouped tabs (dragged out, restored loose), go
  to a grey `Inbox` group. Inbox is always the last group in the window. Pinned tabs are left
  alone.
- **Group names are unique** within a window and compared case-insensitively.
- **Snapshots** of every window are saved a few seconds after each change.
- **After a restart**:
  - If Chrome brought back almost nothing, the session is restored automatically.
  - If Chrome brought back only part of it, a red `!` badge appears and you restore by hand
    with leader `u`.
  - Restoring never closes your tabs and never opens a tab that is already there.
  - If you also click Chrome's own "Restore", the duplicate groups are merged automatically.
- **Each window is managed independently.** Search covers all windows.

## Keys

### Leader menu

The toolbar shortcut (`_execute_action`) opens a one-key menu. Press a key to run the action,
Esc to close. You can turn the menu off in Options; the toolbar shortcut then opens search
directly.

| Key | Action |
|---|---|
| `s` / `Space` | Search groups and tabs |
| `n` / `p` | Next / previous tab in the group (wraps) |
| `1`–`9` | Go to tab N of the group (`9` = last) |
| `m` | Move the current tab to a group, or to a new group |
| `)` / `(` | Next / previous group |
| `l` | Last used group |
| `c` | New group |
| `,` | Rename group |
| `k` | Group colour |
| `{` / `}` | Move group left / right (Inbox stays last) |
| `x` | Close group, after confirming (closes its tabs) |
| `r` | Reopen the last group closed with `x` (repeatable) |
| `u` | Restore from a snapshot (adds only what is missing) |
| `M` | Merge same-named groups into this window |
| `o` | Options |

### Search

- Type to filter. Space-separated words must all match, and the order of the words does not
  matter.
- Each tab matches on its group name, title and URL together, so `api login` finds tabs about
  "login" in the group "api".
- Vietnamese diacritics are ignored.
- Use ↑/↓ to choose (PageUp/PageDown jump 8), Enter to open the group or tab, Esc to close.

### Shortcuts

Every action is also a command that can be bound to a key at `chrome://extensions/shortcuts`.
Commands are numbered so they sort by category: 1x picker, 2x group, 3x tab, 4x go to tab N,
5x recovery, 9x debug.

Bound for now, temporarily:

- `Alt+S`: leader menu
- `Alt+.` / `Alt+,`: next / previous group
- `Alt+Shift+D`: diagnostics

The final key layout is still to be decided.

Chrome has some limits on which keys a command can use:

- Every key needs Ctrl or Alt, and Ctrl+Alt is not allowed.
- Chrome's own keys can't be taken, such as Ctrl+T/W/N/Tab/1–9 and Alt+G.
- Suggested keys apply only on the first install.

## Options

Open with leader `o`, or from the extension's details page.

- Leader menu on or off.
- Number of snapshots to keep (default 10).
- Snapshot delay (default 3 s).
- Whether restored tabs wait until opened before loading (default on).

## Troubleshooting

Open diagnostics with `Alt+Shift+D` and use these keys:

| Key | Action |
|---|---|
| `c` | Copy the event log, build time and shortcuts as JSON |
| `d` | Dump the live tabs and groups |
| `n` | Take a snapshot now |
| `v` | View the latest snapshot |
| `x` | Clear the log |

If the `build` line differs from `sw.start.build` in the log, reload the extension.

## Development

```bash
pnpm typecheck
pnpm test        # vitest, pure logic in src/shared
pnpm dev         # watch build
```
