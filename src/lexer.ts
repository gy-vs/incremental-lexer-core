import { LexerConfig, LexerRule, Token } from './types';

/** A rule compiled for fast sticky matching. */
export interface CompiledRule {
  type: string;
  regex: RegExp;
  priority: number;
  order: number;
  push?: string;
  pop: boolean;
  next?: string;
  skip: boolean;
}

export interface CompiledRules {
  byState: Map<string, CompiledRule[]>;
  initialState: string;
  errorType: string;
}

/**
 * Interner for state stacks. Identical stacks share one frozen array object, so
 * "same lexer state" is a reference-equality check during resynchronization.
 */
export class StackInterner {
  private readonly map = new Map<string, readonly string[]>();

  intern(stack: readonly string[]): readonly string[] {
    const key = stack.join('');
    let hit = this.map.get(key);
    if (hit === undefined) {
      hit = Object.freeze(stack.slice());
      this.map.set(key, hit);
    }
    return hit;
  }
}

function compileRule(rule: LexerRule, order: number, initialState: string): { compiled: CompiledRule; states: readonly string[] } {
  const transitions =
    (rule.push !== undefined ? 1 : 0) +
    (rule.pop === true ? 1 : 0) +
    (rule.next !== undefined ? 1 : 0);
  if (transitions > 1) {
    throw new Error(`Rule "${rule.type}": push, pop and next are mutually exclusive`);
  }
  if (rule.type.length === 0) {
    throw new Error('Rule type must not be empty');
  }
  const flags = rule.pattern.flags.includes('y') ? rule.pattern.flags : rule.pattern.flags + 'y';
  const regex = new RegExp(rule.pattern.source, flags);
  if (regex.test('')) {
    throw new Error(`Rule "${rule.type}" must not match the empty string`);
  }
  const compiled: CompiledRule = {
    type: rule.type,
    regex,
    priority: rule.priority ?? 0,
    order,
    push: rule.push,
    pop: rule.pop ?? false,
    next: rule.next,
    skip: rule.skip ?? false,
  };
  return { compiled, states: rule.states ?? [initialState] };
}

export function compileRules(config: LexerConfig): CompiledRules {
  const initialState = config.initialState ?? 'main';
  const byState = new Map<string, CompiledRule[]>();
  config.rules.forEach((rule, order) => {
    const { compiled, states } = compileRule(rule, order, initialState);
    for (const state of states) {
      let list = byState.get(state);
      if (list === undefined) {
        list = [];
        byState.set(state, list);
      }
      list.push(compiled);
    }
  });
  if (!byState.has(initialState)) {
    throw new Error(`No rules defined for initial state "${initialState}"`);
  }
  return { byState, initialState, errorType: config.errorType ?? 'error' };
}

export interface RawMatch {
  /** null for an unmatched (error) character. */
  rule: CompiledRule | null;
  length: number;
}

/**
 * Longest match at `pos` among the rules active in `state`. Ties are broken
 * by priority, then by rule order. Falls back to a single-character error
 * match so lexing always makes progress.
 */
export function matchAt(text: string, pos: number, state: string, compiled: CompiledRules): RawMatch {
  const rules = compiled.byState.get(state);
  let best: RawMatch | null = null;
  if (rules !== undefined) {
    for (const rule of rules) {
      rule.regex.lastIndex = pos;
      const m = rule.regex.exec(text);
      if (m === null || m.index !== pos) continue;
      const len = m[0].length;
      if (len === 0) continue; // paranoia: empty matches would stall the cursor
      if (
        best === null ||
        len > best.length ||
        (len === best.length &&
          (rule.priority > best.rule!.priority ||
            (rule.priority === best.rule!.priority && rule.order < best.rule!.order)))
      ) {
        best = { rule, length: len };
      }
    }
  }
  if (best === null) {
    const cp = text.codePointAt(pos)!;
    return { rule: null, length: cp > 0xffff ? 2 : 1 };
  }
  return best;
}

/** Apply a matched rule's state transition to the (mutable) stack. */
export function applyTransition(stack: string[], rule: CompiledRule): void {
  if (rule.pop) {
    if (stack.length > 1) stack.pop();
  } else if (rule.push !== undefined) {
    stack.push(rule.push);
  } else if (rule.next !== undefined) {
    stack[stack.length - 1] = rule.next;
  }
}

/** Full tokenization of `text`. */
export function lexAll(text: string, compiled: CompiledRules, interner: StackInterner): Token[] {
  const tokens: Token[] = [];
  const stack: string[] = [compiled.initialState];
  let pos = 0;
  while (pos < text.length) {
    const stateBefore = interner.intern(stack);
    const m = matchAt(text, pos, stack[stack.length - 1], compiled);
    const end = pos + m.length;
    if (m.rule !== null) applyTransition(stack, m.rule);
    const stateAfter = interner.intern(stack);
    if (m.rule === null || !m.rule.skip) {
      tokens.push({
        type: m.rule === null ? compiled.errorType : m.rule.type,
        value: text.slice(pos, end),
        start: pos,
        end,
        state: stateBefore,
        stateAfter,
      });
    }
    pos = end;
  }
  return tokens;
}
