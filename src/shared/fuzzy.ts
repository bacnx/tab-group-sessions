// fzf-style fuzzy matching. Pure, unit tested.
//
// Text is folded (lowercase, Vietnamese diacritics removed, đ → d) one UTF-16 code unit at a
// time, so match positions in the folded text map 1:1 onto the original for highlighting.

/** Folds `s` for matching; the result has exactly the same length as `s`. */
export function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch.charCodeAt(0) < 128) {
      out += ch.toLowerCase();
      continue;
    }
    const base = ch.normalize('NFD')[0] ?? ch;
    const lower = base.toLowerCase();
    const one = lower.length === 1 ? lower : base;
    out += one === 'đ' ? 'd' : one;
  }
  return out;
}

export interface Match {
  score: number;
  /** Indices into the text of the matched characters. */
  positions: number[];
}

const SEPARATORS = ' -_./:?&=#@()[]|,';

function isBoundary(text: string, original: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  if (SEPARATORS.includes(prev)) return true;
  // camelCase boundary, judged on the original casing.
  const o = original[i]!;
  const op = original[i - 1]!;
  return o !== o.toLowerCase() && op === op.toLowerCase() && op !== op.toUpperCase();
}

const SCORE_CHAR = 1;
const BONUS_CONSECUTIVE = 5;
const BONUS_BOUNDARY = 8;
const BONUS_FIRST_CHAR = 4;
const PENALTY_GAP = 0.2;
const PENALTY_GAP_MAX = 3;

/**
 * Matches folded `pattern` as a subsequence of `original`. Tries every occurrence of the first
 * pattern character as a start and keeps the best-scoring greedy alignment.
 */
export function fuzzyMatch(pattern: string, original: string): Match | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  const text = fold(original);
  if (pattern.length > text.length) return null;

  let best: Match | null = null;
  let start = text.indexOf(pattern[0]!);
  while (start !== -1) {
    const positions = [start];
    let ti = start + 1;
    for (let pi = 1; pi < pattern.length; pi++) {
      // Prefer continuing consecutively, else jump to the next boundary occurrence, else any.
      const ch = pattern[pi]!;
      let found = -1;
      if (text[ti] === ch) found = ti;
      else {
        let any = -1;
        for (let j = ti; j < text.length; j++) {
          if (text[j] !== ch) continue;
          if (any === -1) any = j;
          if (isBoundary(text, original, j)) {
            found = j;
            break;
          }
        }
        if (found === -1) found = any;
      }
      if (found === -1) break;
      positions.push(found);
      ti = found + 1;
    }
    if (positions.length === pattern.length) {
      const score = scorePositions(text, original, positions);
      if (!best || score > best.score) best = { score, positions };
    }
    start = text.indexOf(pattern[0]!, start + 1);
  }
  return best;
}

function scorePositions(text: string, original: string, positions: number[]): number {
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k]!;
    score += SCORE_CHAR;
    if (isBoundary(text, original, p)) score += BONUS_BOUNDARY;
    if (k === 0 && p === 0) score += BONUS_FIRST_CHAR;
    if (k > 0) {
      const gap = p - positions[k - 1]! - 1;
      if (gap === 0) score += BONUS_CONSECUTIVE;
      else score -= Math.min(gap * PENALTY_GAP, PENALTY_GAP_MAX);
    }
  }
  return score;
}

/** Splits a query into folded, non-empty tokens. */
export function tokenize(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export interface Field {
  text: string;
  weight: number;
}

export interface FieldsMatch {
  score: number;
  /** Matched positions per field index. */
  positions: number[][];
}

/**
 * AND-matches every token against a set of fields: each token must match at least one field
 * (its best weighted field wins). Returns null if any token matches nothing.
 */
export function matchFields(tokens: string[], fields: Field[]): FieldsMatch | null {
  const positions: number[][] = fields.map(() => []);
  let score = 0;
  for (const token of tokens) {
    let bestScore = -Infinity;
    let bestField = -1;
    let bestPositions: number[] = [];
    fields.forEach((field, i) => {
      const m = fuzzyMatch(token, field.text);
      if (m && m.score * field.weight > bestScore) {
        bestScore = m.score * field.weight;
        bestField = i;
        bestPositions = m.positions;
      }
    });
    if (bestField === -1) return null;
    score += bestScore;
    positions[bestField]!.push(...bestPositions);
  }
  return { score, positions };
}
