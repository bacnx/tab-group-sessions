# M0 verification checklist

Goal: confirm the Chrome behaviours the design relies on before building on them.
Results are recorded in the persisted event log — open **Diagnostics** (`Alt+Shift+D`),
press `c` to copy the log as JSON and hand it over.

Temporary M0 shortcuts (check `chrome://extensions/shortcuts` if one did not register):

| Key | Command |
|---|---|
| `Alt+S` | `_execute_action` — native action popup |
| `Alt+G` | `open-picker` — `chrome.action.openPopup()` |
| `Alt+Shift+G` | `open-picker-window` — fallback popup window |
| `Alt+Shift+D` | `open-diagnostics` |

## 1. Automated probes

Diagnostics page → `p`. A temporary window opens and closes. Covers:

- collapsing a group that contains the active tab
- activating a tab in a collapsed group expands it
- `tabs.group()` into an existing group puts the tab at the end
- event order for `tabs.create({active: true})`
- `tab.lastAccessed` availability
- `tabGroups.move(..., {index: -1})` moves a group to the end
- removing all tabs of a group: events fired, group gone

**Manual follow-up:** check Chrome's saved tab groups list (bookmarks bar / tab search
"Tab groups") for leftover `tgs-probe-A` / `tgs-probe-B` entries — this tells us whether
groups closed via the API (or via window close) linger as saved groups. Delete them after.

## 2. Picker focus

For each launch key `Alt+S`, `Alt+G`, `Alt+Shift+G`, open the picker on each page type and
type a few characters immediately, then Enter (logs the text) and Esc:

- [ ] normal website
- [ ] New Tab page
- [ ] `chrome://settings`
- [ ] a PDF
- [ ] Chrome Web Store
- [ ] window in fullscreen (F11)

Also: with the popup open, press `Alt+G` again — does `commands.onCommand` get logged?

## 3. Ctrl+T and link event order

- [ ] In a grouped tab press `Ctrl+T` → note `tabs.onCreated` / `tabs.onActivated` order and
      the new tab's `group` (expected `-1`, at the end of the strip).
- [ ] Middle-click / Ctrl+click a link in a grouped tab → expected: already in the group.
- [ ] Press Chrome's `Ctrl+Tab` across a collapsed group → does it skip collapsed tabs?

## 4. Boot / restore order

1. Have a few groups (some collapsed) open, close Chrome normally, reopen.
2. Diagnostics: the orange `sw.start freshBoot:true` line marks the boot; check where
   `runtime.onStartup`, the restored `tabs.onCreated` / `tabGroups.onCreated` events and the
   `boot.sample` lines (1 s … 15 s) fall, and whether collapsed state was restored.
3. Optional: kill Chrome from Task Manager, reopen — does Chrome restore automatically or
   show a "Restore" prompt?
