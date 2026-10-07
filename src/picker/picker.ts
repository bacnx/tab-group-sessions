// Unified picker: fuzzy search over groups and tabs of every normal window. Keyboard only:
// typing filters and selects the first row, ↑/↓ (PageUp/PageDown) move, Enter opens, Esc closes.
// Reads come straight from the chrome.* APIs; mutations go to the service worker queue.

import { NO_GROUP, groupOrder } from '../shared/model';
import { send } from '../shared/messages';
import { search, type PickerData, type PickerGroup, type PickerTab, type Row } from '../shared/search';

const input = document.getElementById('query') as HTMLInputElement;
const list = document.getElementById('results') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLDivElement;

const params = new URLSearchParams(location.search);
const inWindow = params.get('src') === 'window';
if (inWindow) document.body.classList.add('in-window');

const PAGE = 8;

let data: PickerData | undefined;
let rows: Row[] = [];
let selected = 0;
const windowLabels = new Map<number, string>();

async function originWindowId(): Promise<number | undefined> {
  const origin = Number(params.get('origin'));
  if (inWindow && Number.isFinite(origin) && origin > 0) return origin;
  return (await chrome.windows.getCurrent()).id;
}

async function loadData(): Promise<PickerData> {
  const currentWindowId = (await originWindowId()) ?? chrome.windows.WINDOW_ID_NONE;
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

// --- rendering -----------------------------------------------------------------------------

function highlight(text: string, positions: number[], offset = 0): DocumentFragment {
  const frag = document.createDocumentFragment();
  const marks = new Set(positions.map((p) => p - offset));
  let run = '';
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    if (runMarked) {
      const m = document.createElement('mark');
      m.textContent = run;
      frag.append(m);
    } else frag.append(run);
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

function el(tag: string, className: string, content?: string | Node): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (content !== undefined) e.append(content);
  return e;
}

function colorVar(color: string | undefined): string {
  return color ? `var(--g-${color})` : 'var(--muted)';
}

function faviconUrl(pageUrl: string): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}

function renderRow(row: Row, i: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `row ${row.kind}`;
  li.setAttribute('role', 'option');
  li.dataset.index = String(i);

  if (row.kind === 'group') {
    const g = row.group;
    const dot = el('span', 'dot');
    dot.style.setProperty('--c', colorVar(g.color));
    const meta = [`${g.tabCount} tab${g.tabCount === 1 ? '' : 's'}`];
    if (g.id === data?.currentGroupId) meta.push('current');
    const label = windowLabels.get(g.windowId);
    if (label) meta.push(label);
    li.append(dot, el('span', 'title', highlight(g.title || '(untitled)', row.titlePos)), el('span', 'meta', meta.join(' · ')));
  } else {
    const t = row.tab;
    const fav = document.createElement('img');
    fav.className = 'fav';
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
    const prefix = t.url.match(/^https?:\/\//)?.[0] ?? '';
    const label = windowLabels.get(t.windowId);
    const url = el('span', 'url', highlight(t.url.slice(prefix.length), row.urlPos, prefix.length));
    if (label) url.prepend(`${label} · `);
    li.append(url);
  }
  li.addEventListener('click', () => {
    selected = i;
    void confirm();
  });
  return li;
}

function render(): void {
  list.replaceChildren(...rows.map(renderRow));
  empty.hidden = rows.length > 0;
  updateSelection();
}

function updateSelection(): void {
  for (const li of list.children) li.classList.toggle('selected', Number((li as HTMLElement).dataset.index) === selected);
  list.children[selected]?.scrollIntoView({ block: 'nearest' });
}

function move(delta: number, wrap: boolean): void {
  if (rows.length === 0) return;
  let next = selected + delta;
  if (wrap) next = (next + rows.length) % rows.length;
  else next = Math.max(0, Math.min(rows.length - 1, next));
  selected = next;
  updateSelection();
}

// --- actions -------------------------------------------------------------------------------

async function confirm(): Promise<void> {
  const row = rows[selected];
  if (!row) return;
  if (row.kind === 'group') await send({ type: 'focus-group', groupId: row.group.id });
  else await send({ type: 'activate-tab', tabId: row.tab.id });
  window.close();
}

function update(): void {
  if (!data) return;
  rows = search(data, input.value);
  selected = 0;
  render();
}

input.addEventListener('input', update);

input.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowDown':
      move(1, true);
      break;
    case 'ArrowUp':
      move(-1, true);
      break;
    case 'PageDown':
      move(PAGE, false);
      break;
    case 'PageUp':
      move(-PAGE, false);
      break;
    case 'Enter':
      if (e.isComposing) return;
      void confirm();
      break;
    case 'Escape':
      window.close();
      break;
    case 'Tab':
      break; // keep focus in the input
    default:
      return;
  }
  e.preventDefault();
});

async function main(): Promise<void> {
  input.focus();
  data = await loadData();
  update();
}

void main();
