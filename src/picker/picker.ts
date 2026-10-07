// M0 spike picker: measures whether keyboard focus lands in the input automatically for
// each launch path (native action popup, chrome.action.openPopup(), popup window) and on
// each page type. Results go to the diagnostics log.

import { PENDING_OPEN_KEY, send, type PendingOpen } from '../shared/messages';

const loadedAt = performance.now();
const input = document.getElementById('query') as HTMLInputElement;
const status = document.getElementById('status') as HTMLDivElement;
const diag = document.getElementById('diag') as HTMLPreElement;

function diagLog(ev: string, data?: unknown) {
  void send({ type: 'diag-log', ev, data });
}

async function detectSource(): Promise<string> {
  const params = new URLSearchParams(location.search);
  if (params.get('src') === 'window') {
    document.body.classList.add('in-window');
    return 'window';
  }
  const pending = (await chrome.storage.session.get(PENDING_OPEN_KEY))[PENDING_OPEN_KEY] as PendingOpen | undefined;
  await chrome.storage.session.remove(PENDING_OPEN_KEY);
  if (pending && Date.now() - pending.ts < 3000) return pending.src;
  return 'action'; // toolbar click or _execute_action shortcut
}

interface FocusSample {
  ms: number;
  docFocus: boolean;
  inputFocus: boolean;
}

function sample(): FocusSample {
  return {
    ms: Math.round(performance.now() - loadedAt),
    docFocus: document.hasFocus(),
    inputFocus: document.activeElement === input,
  };
}

async function main() {
  const src = await detectSource();
  const win = await chrome.windows.getCurrent();
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const context = { src, windowId: win.id, windowType: win.type, pageUrl: activeTab?.url };

  const samples: FocusSample[] = [sample()];
  let firstKey: { key: string; ms: number } | undefined;
  let forcedFocus = false;

  input.addEventListener('keydown', (e) => {
    if (!firstKey) firstKey = { key: e.key, ms: Math.round(performance.now() - loadedAt) };
    if (e.key === 'Escape') {
      e.preventDefault();
      diagLog('picker.close', { ...context, via: 'Escape' });
      window.close();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      diagLog('picker.enter', { ...context, text: input.value, firstKey });
      status.textContent = `Logged "${input.value}"`;
    }
  });

  for (const delay of [50, 250]) {
    await new Promise((r) => setTimeout(r, delay));
    const s = sample();
    samples.push(s);
    if (!s.inputFocus) {
      input.focus();
      forcedFocus = true;
    }
  }

  const result = { ...context, samples, forcedFocus };
  diagLog('picker.focus', result);
  status.textContent = `src=${src} · input focused at load: ${samples[0]?.inputFocus} · forced: ${forcedFocus}`;
  diag.textContent = JSON.stringify(result, null, 2);
}

void main();
