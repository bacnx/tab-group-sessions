// M0 spike: automated probes for Chrome behaviours the design depends on. They run in a
// throw-away window so the user's real groups are never touched. Groups created here are
// titled `tgs-probe-*` so they are recognisable if Chrome keeps them as saved groups.

import { log } from '../shared/log';
import { ignoredWindows } from './focus';

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let tap: string[] | null = null;

/** Called by every tab/group listener so probes can observe event order. */
export function recordTap(ev: string, info?: string): void {
  tap?.push(info ? `${ev}(${info})` : ev);
}

async function withTap<T>(fn: () => Promise<T>, settleMs = 400): Promise<{ result: T; events: string[] }> {
  tap = [];
  try {
    const result = await fn();
    await sleep(settleMs);
    return { result, events: tap };
  } finally {
    tap = null;
  }
}

export async function runProbes(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const add = (r: ProbeResult) => {
    results.push(r);
    log('probe', r);
  };

  const win = await chrome.windows.create({
    url: ['about:blank', 'about:blank', 'about:blank', 'about:blank'],
    focused: true,
  });
  const windowId = win?.id;
  if (windowId === undefined) {
    add({ name: 'probe-runner', ok: false, detail: { error: 'could not create probe window' } });
    return results;
  }
  ignoredWindows.add(windowId);
  try {
    const tabs = (await chrome.tabs.query({ windowId })).sort((x, y) => x.index - y.index);
    const [a, b, c] = tabs.map((t) => t.id!);
    if (a === undefined || b === undefined || c === undefined) throw new Error('probe window has too few tabs');
    const name = (id: number) => (id === a ? 'a' : id === b ? 'b' : id === c ? 'c' : String(id));

    const ga = await chrome.tabs.group({ tabIds: [a], createProperties: { windowId } });
    await chrome.tabGroups.update(ga, { title: 'tgs-probe-A' });
    const gb = await chrome.tabs.group({ tabIds: [b], createProperties: { windowId } });
    await chrome.tabGroups.update(gb, { title: 'tgs-probe-B' });

    // P1: collapsing the group that contains the active tab.
    {
      await chrome.tabs.update(a, { active: true });
      let error: string | undefined;
      try {
        await chrome.tabGroups.update(ga, { collapsed: true });
      } catch (err) {
        error = String(err);
      }
      await sleep(150);
      const group = await chrome.tabGroups.get(ga);
      const [active] = await chrome.tabs.query({ windowId, active: true });
      add({
        name: 'collapse-group-with-active-tab',
        ok: true,
        detail: { error, collapsedAfter: group.collapsed, activeTabAfter: active ? name(active.id!) : null },
      });
      await chrome.tabGroups.update(ga, { collapsed: false });
    }

    // P2: activating a tab inside a collapsed group expands that group.
    {
      await chrome.tabs.update(c, { active: true });
      await chrome.tabGroups.update(gb, { collapsed: true });
      await chrome.tabs.update(b, { active: true });
      await sleep(150);
      const group = await chrome.tabGroups.get(gb);
      add({ name: 'activate-tab-in-collapsed-group-expands', ok: !group.collapsed, detail: { collapsedAfter: group.collapsed } });
    }

    // P3: tabs.group() into an existing group places the tab at the end of that group.
    {
      const e = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
      await chrome.tabs.group({ tabIds: [e.id!], groupId: ga });
      const members = (await chrome.tabs.query({ windowId, groupId: ga })).sort((x, y) => x.index - y.index);
      const last = members[members.length - 1];
      add({
        name: 'group-into-existing-goes-to-end',
        ok: last?.id === e.id,
        detail: { memberIndices: members.map((t) => t.index), newTabIndex: members.find((t) => t.id === e.id)?.index },
      });
    }

    // P4: event order when a tab is created and activated (approximates Ctrl+T).
    {
      const { events } = await withTap(() => chrome.tabs.create({ windowId, active: true }));
      add({ name: 'event-order-tabs-create-active', ok: true, detail: { events } });
    }

    // P5: tab.lastAccessed is available.
    {
      const t = await chrome.tabs.get(a);
      add({ name: 'tab-lastAccessed-available', ok: typeof t.lastAccessed === 'number', detail: { lastAccessed: t.lastAccessed } });
    }

    // P6: moving a group to the end of the tab strip (used to keep Inbox last).
    {
      await chrome.tabGroups.move(ga, { index: -1 });
      const strip = (await chrome.tabs.query({ windowId })).sort((x, y) => x.index - y.index);
      const lastTab = strip[strip.length - 1];
      add({ name: 'tabGroups-move-to-end', ok: lastTab?.groupId === ga, detail: { stripGroups: strip.map((t) => t.groupId) } });
    }

    // P7: removing all tabs of a group — which events fire and does the group disappear?
    {
      const members = await chrome.tabs.query({ windowId, groupId: gb });
      const { events } = await withTap(() => chrome.tabs.remove(members.map((t) => t.id!)));
      const remaining = await chrome.tabGroups.query({ windowId, title: 'tgs-probe-B' });
      add({ name: 'remove-group-tabs', ok: remaining.length === 0, detail: { events, groupStillExists: remaining.length > 0 } });
    }
  } catch (err) {
    add({ name: 'probe-runner', ok: false, detail: { error: String(err) } });
  } finally {
    await chrome.windows.remove(windowId).catch(() => undefined);
    ignoredWindows.delete(windowId);
  }
  return results;
}
