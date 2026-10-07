// Ranking for the unified picker: one list of group rows and tab rows. Pure, unit tested.

import { matchFields, tokenize } from './fuzzy';
import { NO_GROUP } from './model';

export interface PickerGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
  tabCount: number;
}

export interface PickerTab {
  id: number;
  windowId: number;
  groupId: number;
  index: number;
  title: string;
  url: string;
  pinned: boolean;
  active: boolean;
  lastAccessed?: number;
}

export interface PickerData {
  currentWindowId: number;
  /** Group of the current window's active tab (or most recent group). */
  currentGroupId?: number;
  /** Groups in tab-strip order, windows in display order. */
  groups: PickerGroup[];
  tabs: PickerTab[];
}

export type Row =
  | { kind: 'group'; group: PickerGroup; score: number; titlePos: number[] }
  | {
      kind: 'tab';
      tab: PickerTab;
      group?: PickerGroup;
      score: number;
      titlePos: number[];
      groupPos: number[];
      urlPos: number[];
    };

const WEIGHT_TITLE = 1;
const WEIGHT_GROUP = 0.9;
const WEIGHT_URL = 0.6;
/** Group rows beat tabs whose fields match equally well. */
const GROUP_ROW_BONUS = 10;

export function search(data: PickerData, query: string, limit = 100): Row[] {
  const groupsById = new Map(data.groups.map((g) => [g.id, g]));
  const tokens = tokenize(query);

  if (tokens.length === 0) return defaultRows(data, groupsById).slice(0, limit);

  const rows: Row[] = [];
  for (const group of data.groups) {
    const m = matchFields(tokens, [{ text: group.title, weight: WEIGHT_TITLE }]);
    if (m) rows.push({ kind: 'group', group, score: m.score + GROUP_ROW_BONUS, titlePos: m.positions[0]! });
  }
  for (const tab of data.tabs) {
    const group = tab.groupId !== NO_GROUP ? groupsById.get(tab.groupId) : undefined;
    const m = matchFields(tokens, [
      { text: tab.title, weight: WEIGHT_TITLE },
      { text: group?.title ?? '', weight: WEIGHT_GROUP },
      { text: tab.url, weight: WEIGHT_URL },
    ]);
    if (m) {
      rows.push({
        kind: 'tab',
        tab,
        group,
        score: m.score,
        titlePos: m.positions[0]!,
        groupPos: m.positions[1]!,
        urlPos: m.positions[2]!,
      });
    }
  }

  const windowOf = (r: Row) => (r.kind === 'group' ? r.group.windowId : r.tab.windowId);
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      Number(windowOf(b) === data.currentWindowId) - Number(windowOf(a) === data.currentWindowId) ||
      Number(b.kind === 'group') - Number(a.kind === 'group'),
  );
  return rows.slice(0, limit);
}

/** Empty query: groups (current window first, strip order), then tabs by recency. */
function defaultRows(data: PickerData, groupsById: Map<number, PickerGroup>): Row[] {
  const current = data.groups.filter((g) => g.windowId === data.currentWindowId);
  const others = data.groups.filter((g) => g.windowId !== data.currentWindowId);
  const groupRows: Row[] = [...current, ...others].map((group) => ({ kind: 'group', group, score: 0, titlePos: [] }));

  const tabRows: Row[] = data.tabs
    .filter((t) => !(t.active && t.windowId === data.currentWindowId))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .map((tab) => ({
      kind: 'tab',
      tab,
      group: tab.groupId !== NO_GROUP ? groupsById.get(tab.groupId) : undefined,
      score: 0,
      titlePos: [],
      groupPos: [],
      urlPos: [],
    }));
  return [...groupRows, ...tabRows];
}
