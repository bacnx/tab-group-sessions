import { describe, expect, it } from 'vitest';
import { fold, fuzzyMatch, matchFields, tokenize } from './fuzzy';

describe('fold', () => {
  it('removes Vietnamese diacritics and lowercases, keeping length', () => {
    const s = 'Tiếng Việt Đường ĐI';
    expect(fold(s)).toBe('tieng viet duong di');
    expect(fold(s)).toHaveLength(s.length);
  });

  it('keeps emoji length stable', () => {
    const s = 'a😀b';
    expect(fold(s)).toHaveLength(s.length);
  });
});

describe('fuzzyMatch', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyMatch('gh', 'GitHub')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'GitHub')).toBeNull();
  });

  it('matches across diacritics', () => {
    const m = fuzzyMatch('viet', 'Tiếng Việt');
    expect(m?.positions).toEqual([6, 7, 8, 9]);
  });

  it('prefers consecutive and boundary matches', () => {
    const exact = fuzzyMatch('pull', 'Pull requests')!;
    const scattered = fuzzyMatch('pull', 'pxuxlxl')!;
    expect(exact.score).toBeGreaterThan(scattered.score);
  });

  it('picks the best start occurrence', () => {
    // "street" also contains "re", but the word start of "requests" scores higher.
    const m = fuzzyMatch('req', 'street requests')!;
    expect(m.positions).toEqual([7, 8, 9]);
  });

  it('gives a boundary bonus for camelCase', () => {
    const camel = fuzzyMatch('pr', 'pullRequest')!;
    expect(camel.positions).toEqual([0, 4]);
  });
});

describe('tokenize', () => {
  it('splits on whitespace and folds', () => {
    expect(tokenize('  API  Đăng nhập ')).toEqual(['api', 'dang', 'nhap']);
  });
});

describe('matchFields', () => {
  const fields = (group: string, title: string, url: string) => [
    { text: title, weight: 1 },
    { text: group, weight: 0.9 },
    { text: url, weight: 0.6 },
  ];

  it('requires every token to match some field', () => {
    expect(matchFields(['api', 'login'], fields('api', 'Login page', 'https://x.dev/login'))).not.toBeNull();
    expect(matchFields(['api', 'logout'], fields('api', 'Login page', 'https://x.dev/login'))).toBeNull();
  });

  it('records positions in the field that matched best', () => {
    const m = matchFields(['api'], fields('api', 'Login page', 'https://x.dev/'))!;
    expect(m.positions[1]).toEqual([0, 1, 2]);
    expect(m.positions[0]).toEqual([]);
  });
});
