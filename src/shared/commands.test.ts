import { describe, expect, it } from 'vitest';
import manifest from '../../static/manifest.json';
import { RECOMMENDED_KEYS, allCommandNames, focusGroupCommand, gotoTabCommand, normalizeShortcut, parseFocusGroup, parseGotoTab } from './commands';

describe('commands', () => {
  it('match the manifest exactly', () => {
    expect(Object.keys(manifest.commands).sort()).toEqual(allCommandNames().sort());
  });

  it('suggest exactly the recommended suggested keys (max 4)', () => {
    const commands = manifest.commands as Record<string, { suggested_key?: { default: string } }>;
    const suggested = Object.entries(commands)
      .filter(([, c]) => c.suggested_key)
      .map(([name, c]) => [name, c.suggested_key!.default]);
    const recommended = RECOMMENDED_KEYS.filter((r) => r.suggested).map((r) => [r.command, r.key]);
    expect(suggested.sort()).toEqual(recommended.sort());
    expect(suggested.length).toBeLessThanOrEqual(4);
  });

  it('recommends known, distinct commands and keys', () => {
    const names = new Set(allCommandNames());
    for (const r of RECOMMENDED_KEYS) expect(names.has(r.command)).toBe(true);
    const keys = RECOMMENDED_KEYS.map((r) => normalizeShortcut(r.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('normalises shortcut spellings', () => {
    expect(normalizeShortcut('Alt+Period')).toBe(normalizeShortcut('Alt+.'));
    expect(normalizeShortcut('Shift+Alt+D')).toBe(normalizeShortcut('Alt+Shift+D'));
    expect(normalizeShortcut('Alt+Comma')).not.toBe(normalizeShortcut('Alt+Period'));
  });

  it('round-trips goto-tab names', () => {
    for (let n = 1; n <= 9; n++) expect(parseGotoTab(gotoTabCommand(n))).toBe(n);
    expect(parseGotoTab('20-next-group')).toBeUndefined();
    expect(parseGotoTab('41-goto-tab-2')).toBeUndefined();
  });

  it('round-trips focus-group names', () => {
    for (let n = 0; n <= 9; n++) expect(parseFocusGroup(focusGroupCommand(n))).toBe(n);
    expect(focusGroupCommand(0)).toBe('60-focus-inbox');
    expect(parseFocusGroup('41-goto-tab-1')).toBeUndefined();
    expect(parseFocusGroup('61-focus-group-2')).toBeUndefined();
  });
});
