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
4. **Unified picker** (one fuzzy search over groups *and* tabs, all windows):
   - Query is split on spaces; every token must fuzzy-match (AND, fzf-style).
   - A tab's haystack is `group title + tab title + URL`; a group row's haystack is its title.
     So `api login` = tabs matching "login" in group "api"; `pull request` = tabs anywhere.
   - Matching ignores Vietnamese diacritics (`tieng viet` matches `Tiếng Việt`, `đ` ≈ `d`).
   - Group rows rank higher when the query matches the group title.
   - Keys: typing filters and auto-selects the first row; ↑/↓ move; Enter confirms; Esc exits.
     Enter is ignored while an IME is composing.
   - Enter on a group = focus that group; Enter on a tab = activate it (switching group/window).
   - Results from other windows show a window label.
5. **Move tab mode**: same picker, lists only groups of the *current window* + "New group…".
6. **Next/prev tab cycles inside the current group** (wraps). `goto-tab-1..9` select the Nth
   tab of the group (9 = last). Chrome's own Ctrl+Tab / Ctrl+1..9 cannot be overridden.
   Moving to another group is done through the picker or next/prev-group.
7. **Group management by keyboard**: rename, close (always **with confirmation**, closes the
   tabs for good), new group, color, reorder, MRU toggle, reopen last closed group.
   Group titles must be **unique per window** (enforced on create/rename; untitled or duplicate
   groups found in the wild get auto-renamed).
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

No content scripts, no host permissions. Permissions: `tabs`, `tabGroups`, `storage`, `alarms`.

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
    restore.ts         boot detection → settle → reconcile → apply focus
    reconcile.ts       PURE: (snapshot, current state) → plan of operations (unit tested)
  picker/              the single keyboard UI (modes: search, move, rename, confirm, color,
                       snapshots, leader). Plain TS + DOM, no framework.
  options/             keyboard-operable settings page
  diagnostics/         M0 spike / debugging page (event log, probes)
  shared/              types, message protocol, fuzzy matcher, URL normalisation, keymap
static/                manifest.json and HTML, copied as-is into dist/
scripts/build.mjs      esbuild build / watch
```

### State

| Data | Where | Notes |
|---|---|---|
| Per-window MRU of groups, `bootId`, boot phase, restore lock, last closed group, pending picker mode | `storage.session` | Cleared on browser restart → a missing `bootId` means "fresh boot" |
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

### Restore algorithm

1. Fresh boot (no `bootId`) → `phase = booting`.
2. Wait until no tab/group events for 2 s (min 3 s, max 15 s).
3. `reconcile(latest good snapshot, current)`: match windows by group-title/URL overlap,
   groups by title (fallback: URL Jaccard ≥ 0.5), tabs by normalised URL as a multiset.
   Output: groups/tabs/windows to create.
4. Apply according to the auto-restore policy, then refocus each window's previously active group.

Duplicate protection comes from the merge being idempotent (running it twice is a no-op) plus
a timed lock in `storage.session`. Safety net: for 10 min after boot, a newly created group
whose title duplicates an existing one in the same window is merged into it (covers clicking
Chrome's own "Restore" bubble after the extension already restored).

## Commands

Names are final; keys are not chosen yet (user will decide). `chrome.commands` limits:
max 4 `suggested_key`s; must include Ctrl or Alt (Mac: Command/MacCtrl/Alt); `Ctrl+Alt` is
forbidden; keys limited to A–Z, 0–9, Comma, Period, Home, End, PageUp, PageDown, Space,
Insert, Delete, arrows, media keys; Chrome's Ctrl+T/W/N/Tab/1..9 and Alt+G (Gemini) can't be
taken; avoid Alt+Space (Windows window menu) and Unikey/EVKey hotkeys.

Temporary keys while developing: `Alt+S` action popup, `Alt+Period` / `Alt+Comma`
next/prev group, `Alt+Shift+D` diagnostics. Everything else unbound.

| Command | Purpose |
|---|---|
| `_execute_action` | Leader menu (or the unified picker when leader is disabled) |
| `open-picker` | Unified search picker |
| `move-tab` | Move current tab to a group / new group |
| `next-group`, `prev-group`, `last-group` | Cycle groups (window order) / MRU toggle |
| `next-tab-in-group`, `prev-tab-in-group` | Cycle tabs inside the current group |
| `goto-tab-1` … `goto-tab-9` | Nth tab of current group (planned binding: Alt+1..9) |
| `new-group`, `rename-group`, `close-group`, `set-group-color` | Group management |
| `move-group-left`, `move-group-right` | Reorder groups |
| `restore-snapshot`, `reopen-closed-group`, `merge-duplicate-groups` | Recovery |

### Leader mode (tmux-style, can be disabled in Options)

Tentative map, finalised in M4: `s`/`Space` picker · `m` move tab · `n`/`p` next/prev tab in
group · `1`–`9` goto tab · `(`/`)` prev/next group · `l` last group · `c` new group ·
`,` rename · `x` close · `{`/`}` move group left/right · `u` restore snapshot.

## Milestones

- [x] **M0** scaffold + spike: probes done; remaining manual checks in `docs/m0-verification.md`
- [x] **M1** focus engine: queue, state, onActivated → focusGroup, next/prev/last-group
- [ ] **M2** auto-grouping: new tabs → active/opener group, strays → Inbox (kept last)
- [ ] **M3** unified picker: fuzzy search, popup + window fallback, in-group tab navigation
- [ ] **M4** group management + move tab + leader mode + options page
- [ ] **M5** snapshots
- [ ] **M6** restore + duplicate merge
- [ ] **M7** polish: reopen closed group, etc.

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
- Chrome split view creates helper tabs `chrome://tab-search.top-chrome/split_new_tab_page.html`
  that appear (inside the group) and disappear quickly — stray-tab logic must tolerate them.

Still to verify: PDF focus, Ctrl+Tab over collapsed groups, a real browser restart (Exit from
the menu), saved-group leftovers.
