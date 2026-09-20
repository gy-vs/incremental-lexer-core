/**
 * incremental-lexer-core —— 可配置规则的增量词法分析内核
 *
 * @example
 * ```ts
 * import { createLexer, INITIAL_STATE } from 'incremental-lexer-core';
 *
 * const lexer = createLexer({
 *   states: {
 *     [INITIAL_STATE]: {
 *       name: INITIAL_STATE,
 *       rules: [{ type: 'word', pattern: /\w+/ }],
 *     },
 *   },
 * });
 *
 * lexer.tokenize('hello world');
 * const r = lexer.update([{ start: 6, end: 11, text: 'there' }]);
 * console.log(r.tokens, r.rescannedChars);
 * ```
 *
 * @packageDocumentation
 */

import { IncrementalLexerImpl } from './incremental-lexer.js';
import type { IncrementalLexer, LexerConfig } from './types.js';

export function createLexer(config: LexerConfig, initialText = ''): IncrementalLexer {
  return new IncrementalLexerImpl(config, initialText);
}

export { IncrementalLexerImpl } from './incremental-lexer.js';
export { LexerEngine, StackInterner } from './engine.js';
export {
  INITIAL_STATE,
  type AffectedRange,
  type Edit,
  type IncrementalLexer,
  type LexerConfig,
  type LexerRule,
  type LexerState,
  type StateName,
  type StateTransition,
  type Token,
  type TokenType,
  type UpdateResult,
} from './types.js';
