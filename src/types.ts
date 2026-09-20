/**
 * Public types for the incremental lexer core.
 */

/** A single lexing rule. */
export interface LexerRule {
  /** Token type name emitted when this rule matches. */
  type: string;
  /**
   * Match pattern. The `y` (sticky) flag is added automatically; the pattern
   * is always anchored at the current position. Patterns that can match the
   * empty string are rejected.
   */
  pattern: RegExp;
  /**
   * States in which this rule is active. Defaults to the initial state.
   */
  states?: readonly string[];
  /**
   * Tie-breaker when two rules match the same length: higher priority wins.
   * Remaining ties are broken by rule order (earlier rule wins).
   * Defaults to 0.
   */
  priority?: number;
  /** Push a state onto the state stack after this rule matches. */
  push?: string;
  /** Pop the current state after this rule matches (no-op at the bottom). */
  pop?: boolean;
  /** Replace the current state after this rule matches. */
  next?: string;
  /** If true, the match advances the cursor but emits no token. */
  skip?: boolean;
}

export interface LexerConfig {
  rules: readonly LexerRule[];
  /** Name of the initial state. Defaults to "main". */
  initialState?: string;
  /** Token type used for unmatched characters. Defaults to "error". */
  errorType?: string;
}

/**
 * A token. `start`/`end` are absolute offsets into the *current* text and are
 * the only mutable fields: incremental updates translate them in place so
 * that unaffected tokens keep their object identity.
 *
 * `state` is the (interned) lexer state stack before this token; `stateAfter`
 * is the stack right after it. They are exposed for inspection and used
 * internally to find resynchronization points.
 */
export interface Token {
  readonly type: string;
  readonly value: string;
  start: number;
  end: number;
  readonly state: readonly string[];
  readonly stateAfter: readonly string[];
}

/**
 * One edit, expressed in coordinates of the *old* text: the range
 * `[start, end)` is replaced by `text`. A batch of edits must not overlap
 * (it may be given in any order; edits are sorted internally).
 */
export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A region of the document that had to be re-lexed during an update. */
export interface AffectedRange {
  /** Character range in coordinates of the *new* text. */
  text: { start: number; end: number };
  /** Token index range (into the new token array). */
  tokens: { start: number; end: number };
}

export interface UpdateResult {
  /** The full new token sequence. */
  tokens: Token[];
  /**
   * Regions that were actually re-scanned, in ascending order. Tokens outside
   * these ranges are the same objects as before the update (positions
   * translated in place when needed).
   */
  affectedRanges: AffectedRange[];
  /**
   * Total number of characters re-scanned during this update. Exposed so
   * callers can verify that updates stay local.
   */
  rescannedChars: number;
}
