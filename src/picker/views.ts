// Keyboard-only building blocks for the picker: a filterable list, a text prompt, a
// confirmation, a key menu and a message. Each view replaces the content of `app` and puts
// focus in an input right away, so keys work without touching the mouse.

const PAGE = 8;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

function header(title: string | undefined): HTMLElement[] {
  return title ? [el('div', 'header', title)] : [];
}

function footer(text: string): HTMLElement {
  return el('footer', '', text);
}

/** Async action result: an error message to show, or nothing on success. */
export type Outcome = Promise<string | void> | string | void;

// --- list ----------------------------------------------------------------------------------

export interface ListView<T> {
  title?: string;
  placeholder: string;
  hint: string;
  filter(query: string): T[];
  /** Fills a row; the row element already has the `row` class. */
  render(item: T, row: HTMLLIElement): void;
  onSelect(item: T, query: string): Outcome;
}

export function showList<T>(app: HTMLElement, view: ListView<T>, close: () => void): void {
  const input = el('input', 'query');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = view.placeholder;
  const list = el('ul', 'results');
  list.setAttribute('role', 'listbox');
  const empty = el('div', 'empty', 'No matches');
  const error = el('div', 'error');
  app.replaceChildren(...header(view.title), el('div', 'search', input), error, list, empty, footer(view.hint));

  let items: T[] = [];
  let selected = 0;

  const updateSelection = () => {
    for (const li of list.children) li.classList.toggle('selected', Number((li as HTMLElement).dataset.index) === selected);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const select = async () => {
    const item = items[selected];
    if (item === undefined) return;
    const err = await view.onSelect(item, input.value);
    if (err) error.textContent = err;
  };

  const update = () => {
    items = view.filter(input.value);
    selected = 0;
    error.textContent = '';
    list.replaceChildren(
      ...items.map((item, i) => {
        const li = el('li', 'row');
        li.setAttribute('role', 'option');
        li.dataset.index = String(i);
        view.render(item, li);
        li.addEventListener('click', () => {
          selected = i;
          void select();
        });
        return li;
      }),
    );
    empty.hidden = items.length > 0;
    updateSelection();
  };

  const move = (delta: number, wrap: boolean) => {
    if (items.length === 0) return;
    const next = selected + delta;
    selected = wrap ? (next + items.length) % items.length : Math.max(0, Math.min(items.length - 1, next));
    updateSelection();
  };

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
        void select();
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        break; // keep focus in the input
      default:
        return;
    }
    e.preventDefault();
  });

  update();
  input.focus();
}

// --- prompt --------------------------------------------------------------------------------

export interface PromptView {
  title: string;
  placeholder: string;
  initial?: string;
  onSubmit(value: string): Outcome;
}

export function showPrompt(app: HTMLElement, view: PromptView, close: () => void): void {
  const input = el('input', 'query');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = view.placeholder;
  input.value = view.initial ?? '';
  const error = el('div', 'error');
  app.replaceChildren(...header(view.title), el('div', 'search', input), error, footer('Enter confirm · Esc cancel'));

  input.addEventListener('input', () => (error.textContent = ''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void Promise.resolve(view.onSubmit(input.value)).then((err) => {
        if (err) error.textContent = err;
      });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  });
  input.focus();
  input.select();
}

// --- key capture (confirm, menu, message) ---------------------------------------------------

/** A visually hidden input that holds focus so plain key presses reach us. */
function keyCatcher(onKey: (e: KeyboardEvent) => void): HTMLInputElement {
  const input = el('input', 'key-catcher');
  input.setAttribute('aria-hidden', 'true');
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    e.preventDefault();
    onKey(e);
  });
  // Keep the field empty and focused no matter what.
  input.addEventListener('input', () => (input.value = ''));
  input.addEventListener('blur', () => setTimeout(() => input.focus(), 0));
  return input;
}

export interface ConfirmView {
  title: string;
  detail: string;
  onConfirm(): Outcome;
}

export function showConfirm(app: HTMLElement, view: ConfirmView, close: () => void): void {
  const error = el('div', 'error');
  const catcher = keyCatcher((e) => {
    if (e.key === 'Enter' || e.key === 'y') {
      void Promise.resolve(view.onConfirm()).then((err) => {
        if (err) error.textContent = err;
      });
    } else if (e.key === 'Escape' || e.key === 'n') {
      close();
    }
  });
  app.replaceChildren(
    ...header(view.title),
    el('div', 'detail', view.detail),
    error,
    catcher,
    footer('Enter / y confirm · Esc / n cancel'),
  );
  catcher.focus();
}

export interface MenuEntry {
  /** Keys as reported by KeyboardEvent.key (' ' for Space). */
  keys: string[];
  /** How the keys are shown, e.g. "1–9". Defaults to the keys joined by " ". */
  label?: string;
  text: string | Node;
  /** Called with the pressed key. */
  run(key: string): void;
}

export interface MenuSection {
  title: string;
  entries: MenuEntry[];
}

function keyLabel(key: string): string {
  return key === ' ' ? 'Space' : key;
}

export function showMenu(app: HTMLElement, title: string, sections: MenuSection[], close: () => void): void {
  const byKey = new Map<string, MenuEntry>();
  const columns = sections.map((section) =>
    el(
      'div',
      'menu-section',
      el('div', 'menu-title', section.title),
      ...section.entries.map((entry) => {
        for (const k of entry.keys) byKey.set(k, entry);
        return el(
          'div',
          'menu-entry',
          el('kbd', '', entry.label ?? entry.keys.map(keyLabel).join(' ')),
          el('span', '', entry.text),
        );
      }),
    ),
  );
  const catcher = keyCatcher((e) => {
    if (e.key === 'Escape') return close();
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    byKey.get(e.key)?.run(e.key);
  });
  app.replaceChildren(...header(title), el('div', 'menu', ...columns), catcher, footer('Press a key · Esc close'));
  catcher.focus();
}

export function showMessage(app: HTMLElement, text: string, close: () => void): void {
  const catcher = keyCatcher(() => close());
  app.replaceChildren(el('div', 'detail', text), catcher, footer('Any key to close'));
  catcher.focus();
}
