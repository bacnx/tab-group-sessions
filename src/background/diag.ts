// Diagnostics: logs every relevant event to the persisted log (survives restarts) so event
// ordering at boot / on Ctrl+T can be inspected, and serves the diagnostics page messages.
// Listeners are registered when this module is evaluated, i.e. synchronously at SW start.

import { log } from '../shared/log';
import type { Message } from '../shared/messages';
import { ensureBoot } from './state';

function shortUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.length > 80 ? `${url.slice(0, 80)}…` : url;
}

function tabInfo(t: chrome.tabs.Tab) {
  return {
    id: t.id,
    win: t.windowId,
    idx: t.index,
    group: t.groupId,
    pinned: t.pinned,
    active: t.active,
    opener: t.openerTabId,
    url: shortUrl(t.url || t.pendingUrl),
  };
}

function groupInfo(g: chrome.tabGroups.TabGroup) {
  return { id: g.id, win: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed };
}

// --- lifecycle -----------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => log('runtime.onStartup'));
chrome.runtime.onInstalled.addListener((d) => log('runtime.onInstalled', { reason: d.reason }));

// --- tabs ----------------------------------------------------------------------------------

chrome.tabs.onCreated.addListener((t) => log('tabs.onCreated', tabInfo(t)));
chrome.tabs.onActivated.addListener((i) => log('tabs.onActivated', i));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Only the fields that matter for grouping/restore; skip noisy title/favicon updates.
  const { groupId, pinned, status, url } = change;
  if (groupId === undefined && pinned === undefined && url === undefined && status !== 'complete') return;
  log('tabs.onUpdated', { tabId, groupId, pinned, status, url: shortUrl(url) });
});
chrome.tabs.onRemoved.addListener((tabId, info) => log('tabs.onRemoved', { tabId, ...info }));
chrome.tabs.onMoved.addListener((tabId, info) => log('tabs.onMoved', { tabId, ...info }));
chrome.tabs.onAttached.addListener((tabId, info) => log('tabs.onAttached', { tabId, ...info }));
chrome.tabs.onDetached.addListener((tabId, info) => log('tabs.onDetached', { tabId, ...info }));

// --- groups --------------------------------------------------------------------------------

chrome.tabGroups.onCreated.addListener((g) => log('tabGroups.onCreated', groupInfo(g)));
chrome.tabGroups.onUpdated.addListener((g) => log('tabGroups.onUpdated', groupInfo(g)));
chrome.tabGroups.onRemoved.addListener((g) => log('tabGroups.onRemoved', groupInfo(g)));
chrome.tabGroups.onMoved.addListener((g) => log('tabGroups.onMoved', groupInfo(g)));

// --- windows -------------------------------------------------------------------------------

chrome.windows.onCreated.addListener((w) => log('windows.onCreated', { id: w.id, type: w.type }));
chrome.windows.onRemoved.addListener((id) => log('windows.onRemoved', { id }));
chrome.windows.onFocusChanged.addListener((id) => log('windows.onFocusChanged', { id }));

chrome.commands.onCommand.addListener((command, tab) => {
  log('commands.onCommand', { command, tabId: tab?.id, windowId: tab?.windowId });
});

// --- messages ------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  switch (msg.type) {
    case 'diag-log':
      log(msg.ev, msg.data);
      sendResponse(true);
      return false;
    case 'dump-state':
      dumpState().then(sendResponse);
      return true;
  }
  return false;
});

async function dumpState() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  return {
    windows: windows.map((w) => ({
      id: w.id,
      focused: w.focused,
      tabs: (w.tabs ?? []).map(tabInfo),
    })),
    groups: groups.map(groupInfo),
  };
}

async function summary() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  return {
    windows: windows.length,
    tabs: windows.reduce((n, w) => n + (w.tabs?.length ?? 0), 0),
    groups: groups.length,
    collapsed: groups.filter((g) => g.collapsed).length,
  };
}

void (async () => {
  const boot = await ensureBoot();
  if (!boot.fresh) {
    log('sw.start', { freshBoot: false, bootId: boot.id, build: __BUILD_TIME__ });
    return;
  }
  log('sw.start', { freshBoot: true, build: __BUILD_TIME__, bootId: boot.id, state: await summary() });
  // Sample the state while Chrome restores the previous session, to learn how long it takes.
  for (const ms of [1000, 3000, 6000, 10000, 15000]) {
    setTimeout(() => void summary().then((s) => log('boot.sample', { ms, ...s })), ms);
  }
})();
