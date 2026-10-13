// Restore planning: compare a snapshot with the live browser and work out what is MISSING.
// Pure, unit tested. The plan only ever adds — it never removes or reorders what exists — and
// running it on a state that already contains everything yields an empty plan. That property
// is what makes restore idempotent (no duplicates when run twice, or after Chrome restored).

import { INBOX_TITLE, normalizeTitle } from './model';
import type { SnapGroup, SnapTab, SnapWindow } from './snapshot';

export interface LiveGroupState {
  id: number;
  title: string;
  urls: string[];
}

export interface LiveWindowState {
  id: number;
  groups: LiveGroupState[];
  /** Pinned and ungrouped tabs. */
  otherUrls: string[];
}

export interface GroupToCreate {
  title: string;
  color: string;
  collapsed: boolean;
  tabs: SnapTab[];
}

export interface WindowPlan {
  /** Existing window to restore into; undefined → open a new window. */
  windowId?: number;
  createGroups: GroupToCreate[];
  addToGroups: { groupId: number; title: string; tabs: SnapTab[] }[];
  pinned: SnapTab[];
  /** Group to focus afterwards (snapshot's active group title). */
  activeGroup?: string;
}

export interface RestorePlan {
  windows: WindowPlan[];
  tabCount: number;
  groupCount: number;
}

/** Canonical form for comparing URLs (scheme/host case, default ports, encoding). */
export function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

class UrlBag {
  private counts = new Map<string, number>();

  constructor(urls: Iterable<string> = []) {
    for (const u of urls) this.add(u);
  }

  add(url: string): void {
    const k = normalizeUrl(url);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  /** Removes one occurrence; true if there was one. */
  take(url: string): boolean {
    const k = normalizeUrl(url);
    const n = this.counts.get(k) ?? 0;
    if (n === 0) return false;
    this.counts.set(k, n - 1);
    return true;
  }

  /** Adds everything still left in `other`. */
  merge(other: UrlBag): void {
    for (const [k, n] of other.counts) this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }

  overlap(urls: Iterable<string>): number {
    const copy = new UrlBag();
    copy.counts = new Map(this.counts);
    let n = 0;
    for (const u of urls) if (copy.take(u)) n++;
    return n;
  }
}

function titleKey(title: string): string {
  return normalizeTitle(title).toLowerCase();
}

function windowUrls(w: LiveWindowState): string[] {
  return [...w.otherUrls, ...w.groups.flatMap((g) => g.urls)];
}

function snapUrls(w: SnapWindow): string[] {
  return [...w.pinned, ...w.ungrouped, ...w.groups.flatMap((g) => g.tabs)].map((t) => t.url);
}

/** Snapshot groups with stray ungrouped tabs folded into Inbox (that is where they belong). */
function snapGroups(w: SnapWindow): SnapGroup[] {
  const groups = w.groups.map((g) => ({ ...g, tabs: [...g.tabs] }));
  if (w.ungrouped.length > 0) {
    const inbox = groups.find((g) => titleKey(g.title) === titleKey(INBOX_TITLE));
    if (inbox) inbox.tabs.push(...w.ungrouped);
    else groups.push({ title: INBOX_TITLE, color: 'grey', collapsed: true, tabs: [...w.ungrouped] });
  }
  return groups;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map(normalizeUrl));
  const sb = new Set(b.map(normalizeUrl));
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Pairs each snapshot window with a live window (index → live), greedily by overlap. */
function matchWindows(snap: SnapWindow[], live: LiveWindowState[]): Map<number, LiveWindowState> {
  const scores: { s: number; l: number; score: number }[] = [];
  snap.forEach((sw, s) => {
    const titles = new Set(sw.groups.map((g) => titleKey(g.title)).filter(Boolean));
    live.forEach((lw, l) => {
      const urlScore = new UrlBag(windowUrls(lw)).overlap(snapUrls(sw));
      const titleScore = lw.groups.filter((g) => g.title && titles.has(titleKey(g.title))).length;
      const score = urlScore + 5 * titleScore;
      if (score > 0) scores.push({ s, l, score });
    });
  });
  scores.sort((a, b) => b.score - a.score);

  const result = new Map<number, LiveWindowState>();
  const usedLive = new Set<number>();
  for (const { s, l } of scores) {
    if (result.has(s) || usedLive.has(l)) continue;
    result.set(s, live[l]!);
    usedLive.add(l);
  }
  // Leftover snapshot windows reuse leftover windows that hold nothing yet (e.g. the single
  // New Tab window Chrome opens when it restored nothing) instead of opening another one.
  snap.forEach((_, s) => {
    if (result.has(s)) return;
    const l = live.findIndex((lw, i) => !usedLive.has(i) && lw.groups.length === 0);
    if (l !== -1) {
      result.set(s, live[l]!);
      usedLive.add(l);
    }
  });
  return result;
}

/** `available` holds the URLs that count as already open; matching tabs are consumed. */
function planWindow(sw: SnapWindow, lw: LiveWindowState | undefined, available: UrlBag): WindowPlan {
  const plan: WindowPlan = { windowId: lw?.id, createGroups: [], addToGroups: [], pinned: [], activeGroup: sw.activeGroup };

  plan.pinned = sw.pinned.filter((t) => !available.take(t.url));

  const unmatchedLive = [...(lw?.groups ?? [])];
  for (const g of snapGroups(sw)) {
    let target: LiveGroupState | undefined;
    const key = titleKey(g.title);
    if (key) {
      target = unmatchedLive.find((lg) => titleKey(lg.title) === key);
    } else {
      // Untitled: fall back to content similarity.
      target = unmatchedLive.find(
        (lg) => !lg.title && jaccard(lg.urls, g.tabs.map((t) => t.url)) >= 0.5,
      );
    }
    if (target) unmatchedLive.splice(unmatchedLive.indexOf(target), 1);

    // A tab already open anywhere in the window counts as present (the user may have moved it).
    const missing = g.tabs.filter((t) => !available.take(t.url));
    if (missing.length === 0) continue;
    if (target) plan.addToGroups.push({ groupId: target.id, title: target.title, tabs: missing });
    else plan.createGroups.push({ title: g.title, color: g.color, collapsed: g.collapsed, tabs: missing });
  }
  return plan;
}

export function reconcile(snapshot: readonly SnapWindow[], live: readonly LiveWindowState[]): RestorePlan {
  const snap = [...snapshot];
  const matches = matchWindows(snap, [...live]);

  // Matched windows first, each against its own tabs. Whatever is left over anywhere in the
  // browser then counts as present for windows that must be opened, so a tab that lives in
  // another window is not duplicated into a new one.
  const plans = new Map<number, WindowPlan>();
  const leftover = new UrlBag();
  const matchedLive = new Set<LiveWindowState>();
  snap.forEach((sw, s) => {
    const lw = matches.get(s);
    if (!lw) return;
    matchedLive.add(lw);
    const bag = new UrlBag(windowUrls(lw));
    plans.set(s, planWindow(sw, lw, bag));
    leftover.merge(bag);
  });
  for (const lw of live) if (!matchedLive.has(lw)) leftover.merge(new UrlBag(windowUrls(lw)));
  snap.forEach((sw, s) => {
    if (!plans.has(s)) plans.set(s, planWindow(sw, undefined, leftover));
  });

  const windows = snap
    .map((_, s) => plans.get(s)!)
    // A window that doesn't exist yet is only worth opening if it gets content.
    .filter((p) => p.windowId !== undefined || windowTabCount(p) > 0);
  return {
    windows,
    tabCount: windows.reduce((n, w) => n + windowTabCount(w), 0),
    groupCount: windows.reduce((n, w) => n + w.createGroups.length, 0),
  };
}

function windowTabCount(p: WindowPlan): number {
  return (
    p.pinned.length +
    p.createGroups.reduce((n, g) => n + g.tabs.length, 0) +
    p.addToGroups.reduce((n, g) => n + g.tabs.length, 0)
  );
}

export function planIsEmpty(plan: RestorePlan): boolean {
  return plan.tabCount === 0;
}

/** One line of a plan, for showing the user exactly what a restore would add. */
export interface PlanEntry {
  /** Group title ('(pinned)' for pinned tabs, '(untitled)' for an untitled group). */
  group: string;
  /** The group does not exist yet and will be created. */
  newGroup: boolean;
  /** The window does not exist yet and will be opened. */
  newWindow: boolean;
  urls: string[];
}

export function describePlan(plan: RestorePlan): PlanEntry[] {
  return plan.windows.flatMap((w) => {
    const newWindow = w.windowId === undefined;
    const entries: PlanEntry[] = [];
    if (w.pinned.length) entries.push({ group: '(pinned)', newGroup: false, newWindow, urls: w.pinned.map((t) => t.url) });
    for (const g of w.addToGroups)
      entries.push({ group: g.title || '(untitled)', newGroup: false, newWindow, urls: g.tabs.map((t) => t.url) });
    for (const g of w.createGroups)
      entries.push({ group: g.title || '(untitled)', newGroup: true, newWindow, urls: g.tabs.map((t) => t.url) });
    return entries;
  });
}

/** Multi-line text form of describePlan, e.g. for a confirmation view. */
export function formatPlan(plan: RestorePlan): string {
  return describePlan(plan)
    .map((e) => {
      const tags = [e.newGroup && 'new group', e.newWindow && 'new window'].filter(Boolean).join(', ');
      const head = `${e.group} — ${e.urls.length} tab${e.urls.length === 1 ? '' : 's'}${tags ? ` (${tags})` : ''}`;
      return [head, ...e.urls.map((u) => `  ${u}`)].join('\n');
    })
    .join('\n');
}
