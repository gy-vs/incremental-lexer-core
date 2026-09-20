import {
  CompiledRules,
  StackInterner,
  applyTransition,
  compileRules,
  lexAll,
  matchAt,
} from './lexer';
import {
  AffectedRange,
  Edit,
  LexerConfig,
  Token,
  UpdateResult,
} from './types';

/** Last token index with `start <= pos`, or -1. */
function lastTokenAtOrBefore(tokens: Token[], pos: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** First token index with `start >= pos`, or `tokens.length`. */
function firstTokenAtOrAfter(tokens: Token[], pos: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let ans = tokens.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start >= pos) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** Index of the token starting exactly at `pos` within `[lo, length)`, or -1. */
function exactIndex(tokens: Token[], pos: number, lo: number): number {
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start === pos) return mid;
    if (tokens[mid].start < pos) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * A maximal run of edits whose potentially-affected token ranges touch.
 * Coordinates: `oldStart`/`newStart` is where re-lexing begins (old/new text),
 * `newEnd` is the end of the last edit in new coordinates; re-lexing may run
 * past it until a resynchronization point is found.
 */
interface Window {
  startIdx: number;
  endIdx: number;
  oldStart: number;
  newStart: number;
  newEnd: number;
  deltaBefore: number;
  deltaAfter: number;
  state: readonly string[];
}

/**
 * A configurable-rule incremental lexer.
 *
 * Usage: `setText()` for the initial full tokenization, then `applyEdits()`
 * with batches of non-overlapping edits expressed in old-text coordinates.
 */
export class IncrementalLexer {
  private readonly compiled: CompiledRules;
  private readonly interner = new StackInterner();
  private readonly initialStack: readonly string[];
  private text = '';
  private tokens: Token[] = [];

  constructor(config: LexerConfig) {
    this.compiled = compileRules(config);
    this.initialStack = this.interner.intern([this.compiled.initialState]);
  }

  /** Replace the whole document and tokenize it from scratch. */
  setText(text: string): Token[] {
    this.text = text;
    this.tokens = lexAll(text, this.compiled, this.interner);
    return this.tokens;
  }

  /** Current token sequence. */
  getTokens(): readonly Token[] {
    return this.tokens;
  }

  /** Current text. */
  getText(): string {
    return this.text;
  }

  /** Convenience wrapper for a single edit. */
  applyEdit(edit: Edit): UpdateResult {
    return this.applyEdits([edit]);
  }

  /**
   * Apply a batch of non-overlapping edits (old-text coordinates) and return
   * the new token sequence plus the ranges that had to be re-scanned.
   *
   * Tokens outside the affected ranges keep their object identity; tokens
   * after an edit have their `start`/`end` translated in place.
   */
  applyEdits(edits: Edit[]): UpdateResult {
    const oldText = this.text;
    const oldTokens = this.tokens;
    const n = oldTokens.length;

    if (edits.length === 0) {
      return { tokens: this.tokens, affectedRanges: [], rescannedChars: 0 };
    }

    const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    for (const e of sorted) {
      if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start || e.end > oldText.length) {
        throw new RangeError(`Invalid edit [${e.start}, ${e.end}) for text of length ${oldText.length}`);
      }
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        throw new Error(
          `Overlapping edits: [${sorted[i - 1].start}, ${sorted[i - 1].end}) and [${sorted[i].start}, ${sorted[i].end})`,
        );
      }
    }

    // Build the new text and the cumulative position delta after each edit.
    const deltas: number[] = new Array(sorted.length);
    let newText = '';
    let cursor = 0;
    let cum = 0;
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      newText += oldText.slice(cursor, e.start);
      newText += e.text;
      cursor = e.end;
      cum += e.text.length - (e.end - e.start);
      deltas[i] = cum;
    }
    newText += oldText.slice(cursor);
    const totalDelta = cum;

    // Group edits into windows whose potentially-affected token ranges touch.
    const windows: Window[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      let s = lastTokenAtOrBefore(oldTokens, e.start);
      let startIdx: number;
      let oldStart: number;
      let state: readonly string[];
      if (s < 0) {
        startIdx = 0;
        oldStart = 0;
        state = this.initialStack;
      } else if (oldTokens[s].start === e.start) {
        // Insertion exactly at a token boundary: the previous token may grow
        // into the inserted text (longest match), so restart before it.
        if (s > 0 && oldTokens[s - 1].end === e.start) s--;
        startIdx = s;
        oldStart = oldTokens[s].start;
        state = oldTokens[s].state;
      } else if (oldTokens[s].end >= e.start) {
        // Edit touches token s: re-lex it from its start.
        startIdx = s;
        oldStart = oldTokens[s].start;
        state = oldTokens[s].state;
      } else {
        // Edit lies in a skipped (e.g. whitespace) gap after token s: restart
        // right after s with its known post-state, preserving s itself.
        startIdx = s + 1;
        oldStart = oldTokens[s].end;
        state = oldTokens[s].stateAfter;
      }
      const endIdx = firstTokenAtOrAfter(oldTokens, e.end);
      const deltaBefore = i > 0 ? deltas[i - 1] : 0;
      const deltaAfter = deltas[i];
      const last = windows.length > 0 ? windows[windows.length - 1] : undefined;
      if (last !== undefined && startIdx <= last.endIdx) {
        last.endIdx = Math.max(last.endIdx, endIdx);
        last.deltaAfter = deltaAfter;
        last.newEnd = e.end + deltaAfter;
      } else {
        windows.push({
          startIdx,
          endIdx,
          oldStart,
          newStart: oldStart + deltaBefore,
          newEnd: e.end + deltaAfter,
          deltaBefore,
          deltaAfter,
          state,
        });
      }
    }

    const newTokens: Token[] = [];
    const affectedRanges: AffectedRange[] = [];
    const stack: string[] = [];
    let rescanned = 0;
    let oldCursor = 0;
    let w = 0;

    const shiftCopy = (from: number, to: number, delta: number): void => {
      for (let i = from; i < to; i++) {
        const t = oldTokens[i];
        if (delta !== 0) {
          t.start += delta;
          t.end += delta;
        }
        newTokens.push(t);
      }
    };

    while (w < windows.length) {
      const win = windows[w];
      if (win.startIdx < oldCursor) {
        w++; // already covered by a previous window's re-scan
        continue;
      }
      // Unaffected tokens before this window: keep identity, translate positions.
      shiftCopy(oldCursor, win.startIdx, win.deltaBefore);

      const rescanStart = win.newStart;
      const affectedTokenStart = newTokens.length;
      stack.length = 0;
      for (const s of win.state) stack.push(s);
      let curDelta = win.deltaAfter;
      let curNewEnd = win.newEnd;
      let consumed = w;
      let pos = rescanStart;
      let syncIdx = -1;

      for (;;) {
        // If the re-scan reaches a later window, absorb it: from its newEnd
        // on, its deltaAfter is the correct old-coordinate mapping.
        while (consumed + 1 < windows.length && pos >= windows[consumed + 1].newStart) {
          consumed++;
          curDelta = windows[consumed].deltaAfter;
          if (windows[consumed].newEnd > curNewEnd) curNewEnd = windows[consumed].newEnd;
        }
        if (pos >= newText.length) {
          syncIdx = n; // fell off the end: tail is replaced entirely
          break;
        }
        if (pos >= curNewEnd) {
          // Resync point: an old token boundary at the same position (mapped
          // to old coordinates) with an identical state stack.
          const idx = exactIndex(oldTokens, pos - curDelta, win.startIdx);
          if (idx >= 0 && oldTokens[idx].state === this.interner.intern(stack)) {
            syncIdx = idx;
            break;
          }
        }
        const stateBefore = this.interner.intern(stack);
        const m = matchAt(newText, pos, stack[stack.length - 1], this.compiled);
        const end = pos + m.length;
        if (m.rule !== null) applyTransition(stack, m.rule);
        const stateAfter = this.interner.intern(stack);
        if (m.rule === null || !m.rule.skip) {
          newTokens.push({
            type: m.rule === null ? this.compiled.errorType : m.rule.type,
            value: newText.slice(pos, end),
            start: pos,
            end,
            state: stateBefore,
            stateAfter,
          });
        }
        pos = end;
      }

      rescanned += pos - rescanStart;
      affectedRanges.push({
        text: { start: rescanStart, end: pos },
        tokens: { start: affectedTokenStart, end: newTokens.length },
      });
      oldCursor = syncIdx;
      w = consumed + 1;
    }
    shiftCopy(oldCursor, n, totalDelta);

    this.text = newText;
    this.tokens = newTokens;
    return { tokens: newTokens, affectedRanges, rescannedChars: rescanned };
  }
}
