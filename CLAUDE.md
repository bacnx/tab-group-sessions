# Tab Group Sessions — Chrome extension

Personal Chrome extension (unpacked, never published) that turns Chrome Tab Groups into
tmux-like "sessions": one group per task, only the focused group is expanded, and every
tab/group/window management action is doable 100% from the keyboard.

## Working conventions

- **Code, comments, docs, commit messages: English. Chat with the user: Vietnamese.**
- Package manager: **pnpm** (pinned via `packageManager`, enabled through corepack; the shims
  live in `%APPDATA%\npm` because `Program Files\nodejs` needs admin).
- Commit when a coherent step is done and builds/typechecks — no need to ask first.
- If something is ambiguous or missing, ask the user **before** implementing it.
- Target: Chrome desktop, currently Windows only (Chrome 154). Keep Mac/Linux possible:
  no hard-coded `Ctrl` in UI key handling — go through the keymap abstraction (`Mod` = Ctrl/Cmd).

## Build & install

```bash
pnpm install
pnpm build        # one-off build into dist/
pnpm dev          # watch mode (rebuilds src/, re-copies static/)
pnpm typecheck
pnpm test         # vitest (pure logic only)
```

Install: `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.
After a rebuild press the reload button on the extension card (or `Ctrl+R` on that page).
Shortcuts: `chrome://extensions/shortcuts`. Suggested keys in the manifest only apply on the
*first* install; changing them later requires remove + re-add or rebinding by hand.

## Requirements (agreed)

1. **Focus group**: switching to a group collapses all other groups *in that window*.
   Rule: *the active group is always the group of the active tab.* Anything that activates a
   tab in another group (Chrome's own Ctrl+Tab / Ctrl+1..9, closing a tab, external link…)
   therefore switches focus to that group.
2. **Inbox**: non-pinned ungrouped tabs that already exist (on install, dragged out of a group,
   restored ungrouped, opened by an external app) go into a per-window group titled `Inbox`.
   Inbox is always kept as the **last** group and otherwise behaves like any group (can be
   focused, closed, cycled through). Deleted Inbox is recreated lazily. Pinned tabs are ignored.
3. **New tabs** (Ctrl+T, links, …) go into the active group (or the opener's group), placed at
   the **end of the group**. Tabs that Chrome already put in a group are left alone.
   Tabs opened by external apps go to Inbox.
   Implementation rule (`decidePlacement`): a *new* tab whose first committed top-frame
   navigation (`webNavigation.onCommitted`) has transition **`start_page`** was handed over by
   another app → Inbox; any other new tab (Ctrl+T, link, bookmark, extension-created) → opener's
   group, else the active (MRU) group; any other stray (dragged out, restored ungrouped,
   unpinned) → Inbox. A new tab stays ungrouped until it commits (max 5 s, then "internal").
   A tab that opens on the New Tab page is always internal. Window focus is **not** used: it
   proved unreliable on Windows (see verified behaviours).
   `openerTabId` is useless for this: Chrome sets it to the active tab for external links too. Placement runs in a per-window sweep
   debounced to 300 ms of quiet (max 3 s), never directly from a single event.
4. **Unified picker** (one fuzzy search over groups *and* tabs, all windows):
   - Query is split on spaces; every token must fuzzy-match (AND, fzf-style).
   - A tab's haystack is `group title + tab title + URL`; a group row's haystack is its title.
     So `api login` = tabs matching "login" in group "api"; `pull request` = tabs anywhere.
   - Matching ignores Vietnamese diacritics (`tieng viet` matches `Tiếng Việt`, `đ` ≈ `d`).
   - Group rows rank higher when the query matches the group title.
   - Keys: typing filters and auto-selects the first row; ↑/↓ move (wrapping), PageUp/PageDown
     jump 8; Enter confirms; Esc exits; Tab is swallowed so focus never leaves the input.
     Enter is ignored while an IME is composing.
   - Empty query: groups (current window first, strip order), then tabs by recency.
   - Matching: per token, best weighted field wins — tab title ×1, group title ×0.9, URL ×0.6;
     group rows get +10. Implemented in `shared/fuzzy.ts` + `shared/search.ts` (unit tested).
   - Enter on a group = focus that group; Enter on a tab = activate it (switching group/window).
   - Results from other windows show a window label.
5. **Move tab mode**: same picker, lists only groups of the *current window* + "New group…".
6. **Next/prev tab cycles inside the current group** (wraps). `goto-tab-1..9` select the Nth
   tab of the group (9 = last; no default key — Chrome's Ctrl+1..9 already stays in the open
   group). Chrome's own Ctrl+Tab / Ctrl+1..9 cannot be overridden.
   Moving to another group is done through the picker, next/prev-group or **focus-group-N**:
   groups are numbered per window from the left, Inbox excluded (`1`–`9`, none past the ninth),
   the Inbox is `0` (`numberGroups` in `shared/model.ts`). Numbers are shown in the picker
   (current window's group rows) and the leader menu, **never written into group titles**
   (decided: renumbering would rewrite titles and saved groups and fight mouse renames).
7. **Group management by keyboard**: rename, close (always **with confirmation**, closes the
   tabs for good), new group, color, reorder, MRU toggle, reopen last closed group.
   Group titles must be **unique per window**, case-insensitive (enforced on keyboard
   create/rename/move-to-new-group). Groups named with the mouse are **not** auto-renamed:
   Chrome creates them untitled and the user types the name over several seconds, so a rename
   would fight the user. Untitled/duplicate groups are dealt with by snapshot matching (M5/M6).
   - Move tab: the tab stays active, so focus follows it into the target group. Pinned tabs
     can't be moved (error shown).
   - New group: a New Tab in a fresh group, focused.
   - Close: focus moves to the MRU group first; if the window would become empty, a New Tab in
     a fresh Inbox is created first. The closed group (window, title, colour, URLs) is pushed
     onto `storage.session.closedGroups` (most recent first, max 10).
   - Reopen closed group (`52`, leader `r`): pops the stack, recreates the group in its original
     window (else the current one) with title/colour, focuses it on its first tab. If that
     window already has a group with the same title, only the missing URLs are added to it.
     Groups closed with the mouse aren't tracked — Chrome's Ctrl+Shift+T covers those.
   - Move group left/right swaps with the neighbour; Inbox never moves and nothing passes it.
8. **Restore after restart** — hybrid strategy:
   - Chrome's "Continue where you left off" (enabled) restores tabs/groups first.
   - The extension snapshots *all normal windows* to `chrome.storage.local`.
   - On boot it waits for Chrome to settle, then reconciles against the latest good snapshot:
     it only **adds what is missing**, never removes or reorders what Chrome restored.
   - Auto-restore policy (a): restore automatically only when the state is near-empty
     (no groups, ≤ 2 tabs); on partial restore just show a `!` badge and wait for the manual
     `restore-snapshot` command.
   - Snapshots include pinned tabs. Restored tabs are created inactive and discarded so they
     don't all load at once.
9. **Multiple windows**: each normal window is managed independently (own focus state, own
   Inbox). Commands act on the last-focused normal window. `popup`/`app`/`devtools` windows
   are ignored.

## Architecture

No content scripts, no host permissions. Permissions: `tabs`, `tabGroups`, `storage`, `alarms`,
`favicon` (picker icons via `/_favicon/`), `webNavigation` (external-tab detection).

```
src/
  background/          service worker
    index.ts           registers every listener synchronously at top level → queue
    queue.ts           serial async queue: ALL events and actions run one at a time
    state.ts           typed wrappers over storage.session / storage.local
    focus.ts           focusGroup(windowId, groupId) — idempotent
    grouping.ts        new/stray tab placement, ensureInbox (kept last)
    actions.ts         switch, move, rename, close, color, reorder, next/prev, MRU…
    commands.ts        chrome.commands.onCommand → actions
    launcher.ts        opens the picker: action.openPopup(), falls back to a popup window
    snapshot.ts        capture, debounce, ring buffer, hash dedupe
    restore.ts         boot detection → settle → reconcile → apply focus; duplicate merge
    reconcile.ts       PURE: (snapshot, current state) → plan of operations (unit tested)
  picker/              the single keyboard UI (modes: search, move, rename, confirm, color,
                       snapshots, leader). Plain TS + DOM, no framework.
  options/             keyboard-operable settings page
  diagnostics/         debugging page (event log, snapshots, shortcuts, state dump)
  shared/              types, message protocol, fuzzy matcher, reconcile + dedupe planners, keymap
static/                manifest.json and HTML, copied as-is into dist/
scripts/build.mjs      esbuild build / watch
scripts/make-icons.mjs renders static/icons/*.png (dependency-free; PNGs are committed)
```

### State

| Data | Where | Notes |
|---|---|---|
| Per-window MRU of groups, `bootId`, boot phase, restore lock, closed-group stack, pending picker mode | `storage.session` | Cleared on browser restart → a missing `bootId` means "fresh boot" |
| Settings, snapshots (ring buffer, default 10) | `storage.local` | Durable |
| Active tab, groups, collapsed state, order | **not stored** — always re-read from Chrome | Last used tab of a group = max `tab.lastAccessed` |

### Event handling rules

- Never trust event payloads: re-read the tab/group inside the handler.
- Every handler and action runs through `queue.ts`; every operation is idempotent. Events
  caused by the extension itself then find the state already consistent and do nothing —
  this is how event loops are avoided (no "ignore next event" flags).
- `focusGroup`: activate the group's most recently used tab → expand → collapse the others.
- While `phase = booting`: no stray-tab grouping, no snapshots.
- Never snapshot on `tabs.onRemoved` with `isWindowClosing` (shutdown would save an empty
  state). A snapshot that drops > 50 % of tabs is stored but flagged `suspicious` and skipped
  by restore.

### Snapshots (M5)

- `shared/snapshot.ts` (pure, tested) builds `Snapshot { id, ts, hash, tabCount, suspicious,
  windows[] }`; each window has `pinned`, `groups[]` (strip order: title, color, collapsed,
  tabs `{url,title}`), `ungrouped`, `activeGroup`, `focused`. Not saved: New Tab page,
  split-view helpers, our own extension pages. Windows with nothing restorable are dropped.
- `background/snapshot.ts`: every tab/group change calls `markDirty()` → write after
  `snapshotDelaySec` (default 3) of quiet; a 1-minute `chrome.alarms` alarm writes a pending
  dirty state if the worker died first. Tab title changes don't trigger (read at capture).
- Skipped when identical to the latest (FNV-1a hash), when no normal window exists, within 2 s
  of a window closing (`isWindowClosing` cancels the pending write), and while booting.
  After a window closes the snapshot is written ~2.25 s later if other windows remain (else an
  exit soon after would keep the closed window in the last snapshot → false `!` on restart);
  a closed tab is written after 1 s instead of `snapshotDelaySec`.
- Ring buffer `storage.local.snapshots`, newest first, `snapshotCount` (default 10); a snapshot
  losing > 50 % of ≥ 6 tabs is `suspicious` (except the one written after a window close);
  trimming never evicts the latest good one.
- Diagnostics: list of snapshots, `n` capture now, `v` view the latest as JSON.

### Restore (M6)

- `shared/reconcile.ts` (pure, tested): `reconcile(snapshot.windows, live) → RestorePlan`.
  Windows are paired greedily by URL overlap + 5 × shared group titles; leftover snapshot
  windows reuse leftover live windows without groups, else become **new windows** (decided).
  Groups match by case-insensitive title, untitled ones by URL Jaccard ≥ 0.5. Tabs are a
  URL multiset per window: a tab already open anywhere in the window (or, for new windows,
  anywhere left over in the browser) counts as present. Stray ungrouped snapshot tabs go to
  Inbox. The plan only adds; reconciling after applying it yields an empty plan (tested).
- `background/restore.ts`, boot flow (every SW start, no-op once `phase = ready`):
  1. `phase = booting` → stray sweep and snapshots are paused.
  2. Wait until no structural tab/group event for 2 s (min 3 s, max 15 s from boot).
  3. Pin the previous session's latest good snapshot (`storage.local.pinnedSnapshotId`) — the
     ring buffer never evicts it, the restore picker lists it first as "last session".
  4. Reconcile. Near-empty live state (no groups, ≤ 2 tabs) → restore automatically.
     Otherwise a non-empty plan → red `!` badge + tooltip (missing group names), nothing
     restored. The `restore.boot` log entry lists every missing URL by group (`missing`).
  5. Re-apply focus in every window: Chrome's restored active tab wins if grouped, else the
     snapshot's active group. 6. `phase = ready`, sweep all windows, take a snapshot.
- A normal window created later while it is the only one (Chrome reopened from background)
  gets the same near-empty auto-restore.
- Execution: tabs created inactive, grouped in the same queued task (the stray sweep never
  sees them), groups get title/colour and start collapsed; a new window's placeholder New Tab
  is removed, and on auto-restore the startup New Tab of the near-empty window too. Tabs are
  discarded if `discardOnRestore` (default on) — **only after their URL has committed**.
  Unopenable URLs skipped.
- Manual restore: picker mode `snapshots` (leader `u`, `50-restore-snapshot`) lists snapshots
  with a preview ("adds N tabs, M groups" / "nothing missing"); Enter shows every URL that
  would be added, by group (`formatPlan`), and a second Enter merges; Esc goes back.
- Duplicate merge (`shared/dedupe.ts`, pure, tested): a merge moves the duplicate's tabs into
  the kept group and closes those whose URL the kept group already has. Titles compare
  case-insensitively; untitled groups never merge; **Inbox never merges across windows**.
  - Automatic (`push`): when ≥ 2 groups are created within 1 s in a window (a bulk restore,
    e.g. Chrome's own "Restore" clicked after ours, or Chrome restoring into a new window),
    within 10 min of boot, after boot. Same titles in that window merge into the first in strip
    order; then each of its groups that has a same-named group in another window holding
    ≥ 50 % of its URLs merges into that one (tabs move across windows; an emptied window
    closes). A same-named group with different content is left alone.
  - Manual (`pull`, leader `M` / `51-merge-duplicate-groups`): inside the current window, then
    every same-named group of other windows is pulled into the current window, no overlap
    required.

## Commands

Names are final. `chrome.commands` limits:
max 4 `suggested_key`s; must include Ctrl or Alt (Mac: Command/MacCtrl/Alt); `Ctrl+Alt` is
forbidden; keys limited to A–Z, 0–9, Comma, Period, Home, End, PageUp, PageDown, Space,
Insert, Delete, arrows, media keys; Chrome's Ctrl+T/W/N/Tab/1..9 and Alt+G (Gemini) can't be
taken; avoid Alt+Space (Windows window menu) and Unikey/EVKey hotkeys.

**Default layout (agreed)** — source of truth `RECOMMENDED_KEYS` in `shared/commands.ts`;
a unit test keeps the manifest's `suggested_key`s equal to the entries marked `suggested`:
`Alt+A` leader (`_execute_action`)*, `Alt+S` search (`10`)*, `Alt+.` / `Alt+,` next/prev
group*, `Alt+L` last group, `Alt+1..9` focus group N, `Alt+0` Inbox, `Alt+M` move tab, `Alt+C` new group, `Alt+X`
close group, `Alt+Shift+D` diagnostics. (* = suggested in the manifest; the rest are bound by
hand.) Everything else goes through the leader. Options shows recommended vs. current bindings.
Also avoided: Alt+F/Alt+E (Chrome menu), Alt+D (address bar), Alt+Z (Unikey), Alt+Shift+letter
(Google Docs menu accelerators).

Command names live in `src/shared/commands.ts` (`CMD`) and must match `static/manifest.json`
(enforced by a unit test). Chrome lists commands **sorted by name**, so names carry a numeric
prefix that groups them on `chrome://extensions/shortcuts`, and descriptions start with the
category. Renaming a command drops its binding — keep names stable once assigned.

| Prefix | Commands |
|---|---|
| — | `_execute_action` — toolbar popup (picker now; leader menu from M4) |
| 1x Picker | `10-open-picker` (search; openPopup, window fallback in fullscreen), `11-open-picker-window`, `12-open-leader` |
| 2x Group | `20-next-group`, `21-prev-group`, `22-last-group`, `23-move-tab`, `24-new-group`, `25-rename-group`, `26-close-group`, `27-set-group-color`, `28-move-group-left`, `29-move-group-right` |
| 3x Tab | `30-next-tab-in-group`, `31-prev-tab-in-group` |
| 4x Goto | `41-goto-tab-1` … `49-goto-tab-9` (9 = last; unbound by default) |
| 5x Recovery | `50-restore-snapshot`, `51-merge-duplicate-groups`, `52-reopen-closed-group` |
| 6x Focus | `60-focus-inbox`, `61-focus-group-1` … `69-focus-group-9` (Alt+0..9) |
| 7x–8x | reserved |
| 9x Debug | `90-open-diagnostics` |

### Leader mode (tmux-style, toggle in Options)

`_execute_action` (and `12-open-leader`) opens a key menu; one key runs an action or switches
the picker into a mode. `Esc` closes. Disabled in Options → `_execute_action` opens search.

| Section | Keys |
|---|---|
| Find | `s` / `Space` search |
| Go to group | `1`–`9` group N · `0` Inbox (lists the window's numbered groups) |
| Tab | `n` / `p` next/prev tab in group · `m` move tab to group |
| Group | `)` / `(` next/prev group · `l` last group · `c` new · `,` rename · `k` colour · `{` / `}` move left/right · `x` close |
| Recovery | `u` restore from a snapshot · `r` reopen closed group · `M` merge same-named groups into this window |
| Other | `o` options |

### Picker modes

`picker.html` is one page with modes (`PickerMode`): leader, search, move, new-group, rename,
close, color. The mode comes from the URL (`?mode=`, popup-window fallback), else from
`storage.session.pendingOpen` written by `launcher.openPicker` just before `openPopup()`
(valid 3 s), else the leader/search default. Views live in `src/picker/views.ts` (list,
prompt, confirm, key menu, message); every view puts focus in an input immediately. Key-only
views use a hidden "key catcher" input. Validating actions (move, new, rename, close, colour)
reply with an `ActionResult`; errors are shown inline and the picker stays open.

## Milestones

- [x] **M0** scaffold + spike (probes removed after M7; record in `docs/m0-verification.md`)
- [x] **M1** focus engine: queue, state, onActivated → focusGroup, next/prev/last-group
- [x] **M2** auto-grouping: new tabs → active/opener group, strays → Inbox (kept last)
- [x] **M3** unified picker: fuzzy search, popup + window fallback, in-group tab navigation
- [x] **M4** group management + move tab + leader mode + options page
- [x] **M5** snapshots
- [x] **M6** restore + duplicate merge (auto-restore verified; the discard-after-commit fix,
  manual `u`, normal restart and `M` were not re-tested before 0.1.0)
- [x] **M7** polish: reopen closed group, cross-window duplicate merge, M0 probes removed,
  README, default key layout (verified in Options) — reopen and cross-window merge not
  tested in Chrome before 0.1.0
- **0.1.0** released after M7

## Verified Chrome behaviours

From M0 probes on Chrome 154 / Windows (`docs/m0-verification.md`). Anything not listed
here is still an assumption.

- **The API *can* collapse the group that holds the active tab** — no error, the tab stays
  active inside a collapsed group. So "activate first, then collapse" is mandatory on our side;
  Chrome will not protect us.
- Activating a tab inside a collapsed group auto-expands that group (`tabGroups.onUpdated`
  with `collapsed:false` follows `tabs.onActivated`).
- `tabs.group({groupId})` puts the tab at the end of the existing group (`tabs.onUpdated`
  groupId, then `tabs.onMoved`).
- `tabs.create({active:true})` fires `tabs.onCreated` (groupId -1) **before** `tabs.onActivated`.
  A real Ctrl+T in a grouped tab behaves the same: new tab at the end of the strip, groupId -1,
  `openerTabId` = previous tab.
- `tab.lastAccessed` is available.
- `tabGroups.move(id, {index: -1})` moves a group to the end of the strip.
- Removing a group's tabs fires, per tab: `tabs.onUpdated(groupId=-1)` → `tabGroups.onRemoved`
  → `tabs.onRemoved`. **A closing tab is first ungrouped while it still exists**, so it looks
  exactly like a tab dragged out of its group. Window close does the same, followed by
  `tabs.onRemoved(isWindowClosing=true)`. Consequences: stray-tab handling must wait a moment
  and re-check that the tab still exists; snapshots must not be taken from that transient state.
- `storage.session` survives service worker restarts (`sw.start freshBoot:false` after idle).
- Native action popup (`_execute_action`): input has keyboard focus within ~15–30 ms, verified
  on `chrome://settings` and `chrome://extensions`.
- `Alt+G` is taken by Chrome (Gemini) — an extension cannot claim it.

- `chrome.action.openPopup()` from a command works (no user-gesture problem); input focused
  within ~20 ms. The popup-window fallback opens in ~45 ms with the input focused. NTP verified.
- Commands still fire while the picker *window* is focused; `tab` then belongs to that popup
  window, so launchers/actions must resolve the target normal window themselves.
- **Clicking a tab with the mouse makes tab/group edits fail for a moment** with
  "Tabs cannot be edited right now (user may be dragging a tab)". The queue retries such tasks
  with backoff (up to ~5 s).
- **Closing the last window does not necessarily end the browser session**: Chrome kept
  running (service worker and `storage.session` survived, no `onStartup`) and the window came
  back ~1.5 s later via `windows.onCreated`, fully restored. So restore/reconcile must also run
  per *window creation*, not only on a fresh boot.
- Window restore is a burst of ~50 ms: tabs are created, the first tab of each group arrives
  ungrouped (groupId -1) and is grouped immediately after; `tabGroups.onCreated` arrives with
  an empty title and the title follows in a later `onUpdated`; collapsed state is restored.
  Consequences: stray-tab grouping and untitled-group auto-naming must wait for the burst to
  settle, otherwise they hijack restored tabs/groups. The same "untitled first" pattern applies
  to groups the extension creates itself.

- **In fullscreen (e.g. a YouTube video) `openPopup()` fails with "Browser window has no
  toolbar"**; the popup-window fallback takes over and works. Web Store and NTP verified for
  the action popup.
- `storage.session` is wiped on extension reload/update (fresh `bootId`), so per-window MRU is
  seeded from `tab.lastAccessed` whenever it is empty.
- **Links opened from another app (Teams) get `openerTabId` = the active tab**, exactly like
  Ctrl+T, are created ungrouped at the end of the strip and activated. `tabs.onCreated` for
  such a tab arrives **before** Chrome's window regains focus — but "no focused Chrome window at
  creation" turned out NOT to be reliable (see below).
- **Opening an extension popup reports `windows.onFocusChanged(WINDOW_ID_NONE)`, and closing
  it reports nothing** — focus silently returns to the browser window. Focus tracking alone
  therefore misclassified every Ctrl+T after using the picker as external.
- **`windows.onFocusChanged` is unreliable on Windows** (Chrome 154): switching from Chrome to
  another app often reports nothing, Alt+… extension shortcuts are followed ~5–12 ms later by a
  spurious `WINDOW_ID_NONE`, and closing the action popup by switching apps reports nothing.
  Focus-based external-tab detection misplaced tabs both ways.
- **Links opened from another app commit with transition `start_page`** (Teams verified);
  extension-created tabs commit as `link`, Ctrl+T as `typed`, bookmarks as `auto_bookmark`.
  The first commit arrives ~175 ms after `tabs.onCreated`.
- Extension pages (diagnostics, picker) load fresh files from `dist/` on open, but the manifest
  and service worker only change on **reload** — the diagnostics `build` line can be newer
  than the running worker (compare with `sw.start.build`).
- **Real restart (menu → Exit, relaunch)**: `runtime.onStartup` fires, then the whole window
  with all tabs and groups is recreated within ~5 ms — before the service worker's own boot
  code has even run. Groups arrive untitled and get their titles within ms; collapsed state is
  restored. **About 4–6 s later every group was expanded** (not by us — possibly Chrome while
  lazily loading the restored tabs), so focus/collapse must be re-applied *after* settling.
- Snapshots verified across a real restart: the last pre-exit snapshot survived, no empty or
  suspicious snapshot was written at shutdown.
- **`chrome.tabs.discard()` on a just-created tab (URL not yet committed, `pendingUrl` set)
  replaces it with a new tab id that has NO URL** — 9 of 15 auto-restored tabs came back
  blank. Discard only once `tab.url` is set and `pendingUrl` is gone.
- Auto-restore verified with "Open the New Tab page" at startup: reconcile ran ~3.2 s after
  `onStartup`, near-empty → 15 tabs / 4 groups restored, focus applied.
- Chrome split view creates helper tabs `chrome://tab-search.top-chrome/split_new_tab_page.html`
  that appear (inside the group) and disappear quickly — stray-tab logic must tolerate them.

- Picker focus also verified on the PDF viewer.
- **Groups created through the API become saved groups and get pinned to the bookmarks bar**
  (the `tgs-probe-*` groups stayed there after their window closed). Expect the same for Inbox
  and any group restored by the extension — relevant for M6 duplicate handling.
- The extension keeps working after a real browser exit (menu → Exit) and relaunch.

- **Chrome's Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1..9 skip tabs inside collapsed groups**, so with
  the focus rule they effectively stay within the open group. Our next/prev-tab-in-group mostly
  duplicate them (kept for leader `n`/`p`); goto-tab-N still differs (counts only the group's
  tabs, Chrome's Ctrl+N also counts pinned tabs).
