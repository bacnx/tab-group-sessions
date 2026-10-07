import { describe, expect, it } from 'vitest';
import manifest from '../../static/manifest.json';
import { allCommandNames, gotoTabCommand, parseGotoTab } from './commands';

describe('commands', () => {
  it('match the manifest exactly', () => {
    expect(Object.keys(manifest.commands).sort()).toEqual(allCommandNames().sort());
  });

  it('round-trips goto-tab names', () => {
    for (let n = 1; n <= 9; n++) expect(parseGotoTab(gotoTabCommand(n))).toBe(n);
    expect(parseGotoTab('20-next-group')).toBeUndefined();
    expect(parseGotoTab('41-goto-tab-2')).toBeUndefined();
  });
});
