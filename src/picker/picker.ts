// The single keyboard UI. Opens in a mode — leader menu, search, move tab, new group, rename,
// close, colour — chosen by how it was launched (see launcher.ts). Reads come straight from
// the chrome.* APIs; mutations go to the service worker queue.

import { CMD, gotoTabCommand } from '../shared/commands';
import { matchFields, tokenize } from '../shared/fuzzy';
import { GROUP_COLORS, NO_GROUP, groupOrder, isTitleTaken, normalizeTitle, type GroupColor } from '../shared/model';
import { PENDING_OPEN_KEY, send, type ActionResult, type PendingOpen, type PickerMode } from '../shared/messages';
import { search, type PickerData, type PickerGroup, type PickerTab, type Row } from '../shared/search';
import { getSettings } from '../shared/settings';
import { el, showConfirm, showList, showMenu, showMessage, showPrompt, type Outcome } from './views';

const app = document.getElementById('app') as HTMLDivElement;
const params = new URLSearchParams(location.search);
const inWindow = params.get('src') === 'window';
if (inWindow) document.body.classList.add('in-window');

const closePicker = () => window.close();

async function resolveWindowId(): Promise<number> {
  const origin = Number(params.get('origin'));
  if (inWindow && Number.isFinite(origin) && origin > 0) return origin;
  return (await chrome.windows.getCurrent()).id ?? chrome.windows.WINDOW_ID_NONE;
}

async function resolveMode(): Promise<PickerMode> {
  const fromUrl = params.get('mode') as PickerMode | null;
  if (fromUrl) return fromUrl;
  const pending = (await chrome.storage.session.get(PENDING_OPEN_KEY))[PENDING_OPEN_KEY] as PendingOpen | undefined;
  await chrome.storage.session.remove(PENDING_OPEN_KEY);
  if (pending && Date.now() - pending.ts < 3000) return pending.mode;
  // Toolbar click or the _execute_action shortcut.
  return (await getSettings()).leaderEnabled ? 'leader' : 'search';
}

/** Sends a validating action; closes the picker on success, returns the error otherwise. */
async function act(msg: Parameters<typeof send>[0]): Promise<string | void> {
  const result = await send<ActionResult>(msg);
  if (result?.ok) return closePicker();
  return result?.error ?? 'Something went wrong';
}

function runCommand(windowId: number, command: string): void {
  void send({ type: 'run-command', command, windowId }).then(closePicker);
}

async function currentGroup(windowId: number): Promise<chrome.tabGroups.TabGroup | undefined> {
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (!active || active.groupId === NO_GROUP) return undefined;
  return chrome.tabGroups.get(active.groupId).catch(() => undefined);
}

async function windowGroups(windowId: number): Promise<chrome.tabGroups.TabGroup[]> {
  const byId = new Map((await chrome.tabGroups.query({ windowId })).map((g) => [g.id, g]));
  return groupOrder(await chrome.tabs.query({ windowId }))
    .map((id) => byId.get(id))
    .filter((g): g is chrome.tabGroups.TabGroup => g !== undefined);
}

function colorVar(color: string | undefined): string {
  return color ? `var(--g-${color})` : 'var(--muted)';
}

function dot(color: string | undefined, square = false): HTMLElement {
  const d = el('span', square ? 'dot square' : 'dot');
  d.style.setProperty('--c', colorVar(color));
  return d;
}

function highlight(text: string, positions: number[], offset = 0): DocumentFragment {
  const frag = document.createDocumentFragment();
  const marks = new Set(positions.map((p) => p - offset));
  let run = '';
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    frag.append(runMarked ? el('mark', '', run) : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const marked = marks.has(i);
    if (marked !== runMarked) {
      flush();
      runMarked = marked;
    }
    run += text[i];
  }
  flush();
  return frag;
}

// --- leader --------------------------------------------------------------------------------

function showLeader(windowId: number): void {
  const go = (mode: PickerMode) => () => void start(mode, windowId);
  const cmd = (command: string) => () => runCommand(windowId, command);
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  showMenu(
    app,
    'Leader',
    [
      {
        title: 'Find',
        entries: [{ keys: ['s', ' '], label: 's Space', text: 'Search groups & tabs', run: go('search') }],
      },
      {
        title: 'Tab',
        entries: [
          { keys: ['n'], text: 'Next tab in group', run: cmd(CMD.nextTabInGroup) },
          { keys: ['p'], text: 'Previous tab in group', run: cmd(CMD.prevTabInGroup) },
          {
            keys: digits,
            label: '1–9',
            text: 'Go to tab N (9 = last)',
            run: (key) => runCommand(windowId, gotoTabCommand(Number(key))),
          },
          { keys: ['m'], text: 'Move tab to group', run: go('move') },
        ],
      },
      {
        title: 'Other',
        entries: [
          {
            keys: ['o'],
            text: 'Options',
            run: () => void chrome.runtime.openOptionsPage().then(closePicker),
          },
        ],
      },
      {
        title: 'Group',
        entries: [
          { keys: [')'], text: 'Next group', run: cmd(CMD.nextGroup) },
          { keys: ['('], text: 'Previous group', run: cmd(CMD.prevGroup) },
          { keys: ['l'], text: 'Last group', run: cmd(CMD.lastGroup) },
          { keys: ['c'], text: 'New group', run: go('new-group') },
          { keys: [','], text: 'Rename group', run: go('rename') },
          { keys: ['k'], text: 'Group colour', run: go('color') },
          { keys: ['{'], text: 'Move group left', run: cmd(CMD.moveGroupLeft) },
          { keys: ['}'], text: 'Move group right', run: cmd(CMD.moveGroupRight) },
          { keys: ['x'], text: 'Close group', run: go('close') },
        ],
      },
    ],
    closePicker,
  );
}

// --- search --------------------------------------------------------------------------------

const windowLabels = new Map<number, string>();

async function loadSearchData(currentWindowId: number): Promise<PickerData> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const allGroups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));

  windows.sort((a, b) => Number(b.id === currentWindowId) - Number(a.id === currentWindowId));
  windows.forEach((w, i) => {
    if (w.id !== undefined && w.id !== currentWindowId) windowLabels.set(w.id, `Window ${i + 1}`);
  });

  const groups: PickerGroup[] = [];
  const tabs: PickerTab[] = [];
  let currentGroupId: number | undefined;
  for (const w of windows) {
    const wtabs = w.tabs ?? [];
    for (const id of groupOrder(wtabs)) {
      const g = allGroups.get(id);
      if (!g) continue;
      groups.push({
        id,
        windowId: g.windowId,
        title: g.title ?? '',
        color: g.color,
        tabCount: wtabs.filter((t) => t.groupId === id).length,
      });
    }
    for (const t of wtabs) {
      if (t.id === undefined) continue;
      if (w.id === currentWindowId && t.active && t.groupId !== NO_GROUP) currentGroupId = t.groupId;
      tabs.push({
        id: t.id,
        windowId: t.windowId,
        groupId: t.groupId,
        index: t.index,
        title: t.title || t.url || '',
        url: t.url || t.pendingUrl || '',
        pinned: t.pinned,
        active: t.active,
        lastAccessed: t.lastAccessed,
      });
    }
  }
  return { currentWindowId, currentGroupId, groups, tabs };
}

function faviconUrl(pageUrl: string): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}

function renderSearchRow(row: Row, li: HTMLLIElement, data: PickerData): void {
  if (row.kind === 'group') {
    const g = row.group;
    li.classList.add('group');
    const meta = [`${g.tabCount} tab${g.tabCount === 1 ? '' : 's'}`];
    if (g.id === data.currentGroupId) meta.push('current');
    const label = windowLabels.get(g.windowId);
    if (label) meta.push(label);
    li.append(dot(g.color, true), el('span', 'title', highlight(g.title || '(untitled)', row.titlePos)), el('span', 'meta', meta.join(' · ')));
    return;
  }
  const t = row.tab;
  const fav = el('img', 'fav');
  fav.alt = '';
  if (t.url) fav.src = faviconUrl(t.url);
  li.append(fav, el('span', 'title', highlight(t.title, row.titlePos)));
  if (row.group) {
    const chip = el('span', 'chip', highlight(row.group.title || '(untitled)', row.groupPos));
    chip.style.setProperty('--c', colorVar(row.group.color));
    li.append(chip);
  } else if (t.pinned) {
    li.append(el('span', 'chip', 'pinned'));
  }
  const prefix = /^https?:\/\//.exec(t.url)?.[0] ?? '';
  const url = el('span', 'url', highlight(t.url.slice(prefix.length), row.urlPos, prefix.length));
  const label = windowLabels.get(t.windowId);
  if (label) url.prepend(`${label} · `);
  li.append(url);
}

async function showSearch(windowId: number): Promise<void> {
  const data = await loadSearchData(windowId);
  showList<Row>(
    app,
    {
      placeholder: 'Search groups and tabs — e.g. “api login”',
      hint: '↑↓ select · Enter open · Esc close',
      filter: (q) => search(data, q),
      render: (row, li) => renderSearchRow(row, li, data),
      onSelect: async (row) => {
        if (row.kind === 'group') await send({ type: 'focus-group', groupId: row.group.id });
        else await send({ type: 'activate-tab', tabId: row.tab.id });
        closePicker();
      },
    },
    closePicker,
  );
}

// --- move tab ------------------------------------------------------------------------------

type MoveItem =
  | { kind: 'group'; group: chrome.tabGroups.TabGroup; pos: number[] }
  | { kind: 'new'; title: string };

async function showMove(windowId: number): Promise<void> {
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (active?.pinned) return showMessage(app, 'Pinned tabs stay pinned — unpin the tab first.', closePicker);
  const groups = (await windowGroups(windowId)).filter((g) => g.id !== active?.groupId);
  const allTitles = await chrome.tabGroups.query({ windowId });

  showList<MoveItem>(
    app,
    {
      title: `Move “${active?.title ?? 'tab'}” to…`,
      placeholder: 'Group name — or type a new one',
      hint: '↑↓ select · Enter move · Esc cancel',
      filter: (q) => {
        const tokens = tokenize(q);
        const items: MoveItem[] = [];
        for (const group of groups) {
          const m = tokens.length ? matchFields(tokens, [{ text: group.title ?? '', weight: 1 }]) : { score: 0, positions: [[]] };
          if (m) items.push({ kind: 'group', group, pos: m.positions[0]! });
        }
        if (tokens.length) items.sort((a, b) => scoreOf(b, tokens) - scoreOf(a, tokens));
        const title = normalizeTitle(q);
        if (title === '' || !isTitleTaken(allTitles, title)) items.push({ kind: 'new', title });
        return items;
      },
      render: (item, li) => {
        if (item.kind === 'group') {
          li.classList.add('group');
          li.append(dot(item.group.color, true), el('span', 'title', highlight(item.group.title || '(untitled)', item.pos)));
        } else {
          li.append(el('span', 'plus', '+'), el('span', 'title', item.title ? `New group “${item.title}”` : 'New group…'));
        }
      },
      onSelect: (item): Outcome => {
        if (item.kind === 'group') return act({ type: 'move-tab', windowId, groupId: item.group.id });
        if (item.title) return act({ type: 'move-tab', windowId, newTitle: item.title });
        showPrompt(
          app,
          {
            title: 'Move tab to a new group',
            placeholder: 'Group name',
            onSubmit: (value) => act({ type: 'move-tab', windowId, newTitle: value }),
          },
          closePicker,
        );
      },
    },
    closePicker,
  );
}

function scoreOf(item: MoveItem, tokens: string[]): number {
  if (item.kind !== 'group') return -Infinity;
  return matchFields(tokens, [{ text: item.group.title ?? '', weight: 1 }])?.score ?? -Infinity;
}

// --- group modes ---------------------------------------------------------------------------

async function withCurrentGroup(windowId: number, then: (g: chrome.tabGroups.TabGroup) => void): Promise<void> {
  const group = await currentGroup(windowId);
  if (!group) return showMessage(app, 'The current tab is not in a group.', closePicker);
  then(group);
}

function showNewGroup(windowId: number): void {
  showPrompt(
    app,
    {
      title: 'New group',
      placeholder: 'Group name',
      onSubmit: (value) => act({ type: 'new-group', windowId, title: value }),
    },
    closePicker,
  );
}

function showRename(windowId: number): Promise<void> {
  return withCurrentGroup(windowId, (group) =>
    showPrompt(
      app,
      {
        title: 'Rename group',
        placeholder: 'Group name',
        initial: group.title ?? '',
        onSubmit: (value) => act({ type: 'rename-group', groupId: group.id, title: value }),
      },
      closePicker,
    ),
  );
}

function showClose(windowId: number): Promise<void> {
  return withCurrentGroup(windowId, (group) => {
    void chrome.tabs.query({ groupId: group.id }).then((tabs) =>
      showConfirm(
        app,
        {
          title: `Close group “${group.title || '(untitled)'}”?`,
          detail: `${tabs.length} tab${tabs.length === 1 ? '' : 's'} will be closed.`,
          onConfirm: () => act({ type: 'close-group', groupId: group.id }),
        },
        closePicker,
      ),
    );
  });
}

function showColor(windowId: number): Promise<void> {
  return withCurrentGroup(windowId, (group) =>
    showList<{ color: GroupColor; pos: number[] }>(
      app,
      {
        title: `Colour of “${group.title || '(untitled)'}”`,
        placeholder: 'Colour',
        hint: '↑↓ select · Enter apply · Esc cancel',
        filter: (q) => {
          const tokens = tokenize(q);
          return GROUP_COLORS.flatMap((color) => {
            const m = tokens.length ? matchFields(tokens, [{ text: color, weight: 1 }]) : { score: 0, positions: [[]] };
            return m ? [{ color, pos: m.positions[0]! }] : [];
          });
        },
        render: (item, li) => {
          li.append(dot(item.color), el('span', 'title', highlight(item.color, item.pos)));
          if (item.color === group.color) li.append(el('span', 'meta', 'current'));
        },
        onSelect: (item) => act({ type: 'set-group-color', groupId: group.id, color: item.color }),
      },
      closePicker,
    ),
  );
}

// --- entry ---------------------------------------------------------------------------------

async function start(mode: PickerMode, windowId: number): Promise<void> {
  switch (mode) {
    case 'leader':
      return showLeader(windowId);
    case 'search':
      return showSearch(windowId);
    case 'move':
      return showMove(windowId);
    case 'new-group':
      return showNewGroup(windowId);
    case 'rename':
      return showRename(windowId);
    case 'close':
      return showClose(windowId);
    case 'color':
      return showColor(windowId);
  }
}

async function main(): Promise<void> {
  const [windowId, mode] = await Promise.all([resolveWindowId(), resolveMode()]);
  await start(mode, windowId);
}

void main();
