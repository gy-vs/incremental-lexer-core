/**
 * 分词引擎：规则编译、状态栈驻留（interning）、单次/范围扫描。
 *
 * 状态栈是词法状态名数组（栈底在前）。栈不可变 —— 每次状态切换都产出一个
 * 新栈，并通过 StackInterner 驻留为规范引用，于是“同一状态栈”的比较是 O(1)
 * 引用相等，增量重同步时无需逐元素比较。
 */

import {
  INITIAL_STATE,
  type LexerConfig,
  type LexerRule,
  type StateName,
  type StateTransition,
  type Token,
  type TokenType,
} from './types.js';

interface CompiledRule {
  type: TokenType;
  re: RegExp;
  priority: number;
  order: number;
  ignore: boolean;
  transition: StateTransition | null;
}

interface CompiledState {
  name: StateName;
  rules: CompiledRule[];
}

/** 仅做结构归一化，目标状态存在性在所有状态注册后统一校验 */
function normalizeTransitionShape(next: LexerRule['next']): StateTransition | null {
  if (next === undefined) return null;
  if (typeof next === 'string') return { push: next };
  if ('push' in next) return { push: next.push };
  if ('mode' in next) return { mode: next.mode };
  if ('pop' in next && next.pop === true) return { pop: true };
  return null;
}

export interface ScanOptions {
  /** 扫描左边界（token 边界） */
  start: number;
  /** 硬性扫描终点（通常为文本长度） */
  hardEnd: number;
  /** 进入时的状态栈（引用须为 interner 中的规范栈） */
  stack: readonly StateName[];
  /**
   * 同步判定：扫描到达候选 token 边界 p（p >= rightCap）时调用。
   * 引擎保证已完成 p 之前的全部 token，并前瞻出 p 之后的第一个 token（若有）。
   * 调用方返回“旧侧期望状态栈”表示 p 是合法重同步点；返回 null 表示不同步。
   * 注意：仅在 p 两侧比较不足以保证一致（中间可能已分叉又碰巧回到同类型），
   * 调用方应结合 `boundaryAligned` 对整条边界流的校验结果做决定。
   */
  expectedStackAt?(
    p: number,
    stack: readonly StateName[],
    prevType: string | null,
    nextType: string | null,
    nextLen: number | null,
  ): readonly StateName[] | null | undefined;
  /**
   * 逐边界同构流校验：扫描每越过一个 token 边界（起点在消费前、终点在消费后；
   * ignore token 同样检查）时调用。
   *
   * 返回值：
   *  - true：该边界与旧分词同构，对齐流保持；
   *  - 'diverge'：该边界证明新旧分词已分叉，本次扫描不可能再同步；
   *    引擎仍扫到 hardEnd 产出完整结果，但 synced 必为 false；
   *  - 'skip'：该边界位于编辑影响区内（文本可能不同），本次不判定，
   *    不断流；同步候选也不会在该区段内被询问。
   */
  boundaryAligned?(
    p: number,
    stack: readonly StateName[],
    side: 'start' | 'end',
    tokenType: string,
    /** end 侧检查时给出该 token 的起点；start 侧时等于 p */
    tokenStart: number,
  ): boolean | 'diverge' | 'skip';
  /** 逐边界流校验的最早边界（编辑影响区起点）；更早的边界不校验，默认 start */
  flowFrom?: number;
  /**
   * 早于该偏移的边界不尝试同步（它们在编辑区/公共后缀起点之前）。默认 0。
   */
  rightCap?: number;
}

export interface ScanResult {
  tokens: Token[];
  /** 停止位置（token 边界）；到达 hardEnd 时等于 hardEnd */
  end: number;
  /** 离开时的状态栈（规范引用） */
  stack: readonly StateName[];
  /** 是否因命中同步点提前停止 */
  synced: boolean;
  /** 是否扫描到了 hardEnd（通常即 EOF） */
  reachedHardEnd: boolean;
  /** 是否因边界不对齐被 boundaryAligned 提前判定失败 */
  misaligned: boolean;
}

/** 驻留不可变状态栈 */
export class StackInterner {
  private readonly canonical = new Map<string, readonly StateName[]>();

  intern(stack: readonly StateName[]): readonly StateName[] {
    const key = stack.join(' ');
    const found = this.canonical.get(key);
    if (found !== undefined) return found;
    const frozen = Object.freeze(stack.slice());
    this.canonical.set(key, frozen);
    return frozen;
  }

  initial(): readonly StateName[] {
    return this.intern([INITIAL_STATE]);
  }
}

export class LexerEngine {
  readonly errorType: TokenType;
  private readonly states = new Map<StateName, CompiledState>();
  readonly interner = new StackInterner();

  constructor(config: LexerConfig) {
    this.errorType = config.errorType ?? 'error';
    // 第一阶段：编译所有状态（此时不校验跳转目标是否存在）
    for (const [name, state] of Object.entries(config.states)) {
      if (!state || !Array.isArray(state.rules)) {
        throw new Error(`词法状态 "${name}" 缺少 rules 数组`);
      }
      const compiled: CompiledState = {
        name,
        rules: state.rules.map((rule, order) => this.compileRule(rule, order, name)),
      };
      this.states.set(name, compiled);
    }
    if (!this.states.has(INITIAL_STATE)) {
      throw new Error(`配置必须包含初始状态 "${INITIAL_STATE}"`);
    }
    // 第二阶段：所有状态已注册，统一校验跳转目标
    for (const state of this.states.values()) {
      for (const rule of state.rules) {
        if (rule.transition && 'push' in rule.transition) {
          this.assertState(rule.transition.push, rule.type);
        } else if (rule.transition && 'mode' in rule.transition) {
          this.assertState(rule.transition.mode, rule.type);
        }
      }
    }
  }

  private compileRule(rule: LexerRule, order: number, stateName: StateName): CompiledRule {
    if (typeof rule.type !== 'string' || rule.type.length === 0) {
      throw new Error(`状态 "${stateName}" 的第 ${order} 条规则缺少 type`);
    }
    if (!(rule.pattern instanceof RegExp)) {
      throw new Error(`规则 "${rule.type}" 的 pattern 必须是正则表达式`);
    }
    // 强制 sticky：去掉 g/y，再加 y。保留其它标志（u/s/i 等）由调用方决定。
    const flags = rule.pattern.flags.replace(/[gy]/g, '') + 'y';
    const re = new RegExp(rule.pattern.source, flags);
    const transition = normalizeTransitionShape(rule.next);
    if (rule.next !== undefined && transition === null) {
      throw new Error(`规则 "${rule.type}" 的 next 不是合法的状态切换`);
    }
    return {
      type: rule.type,
      re,
      priority: rule.priority ?? 0,
      order,
      ignore: rule.ignore ?? false,
      transition,
    };
  }

  private assertState(name: StateName, ruleType: string): void {
    if (!this.states.has(name)) {
      throw new Error(`规则 "${ruleType}" 引用了未定义的词法状态 "${name}"`);
    }
  }

  /** 应用状态切换，返回规范的新栈 */
  applyTransition(
    stack: readonly StateName[],
    transition: StateTransition,
  ): readonly StateName[] {
    if ('push' in transition) {
      return this.interner.intern([...stack, transition.push]);
    }
    if ('mode' in transition) {
      const next = stack.slice();
      next[next.length - 1] = transition.mode;
      return this.interner.intern(next);
    }
    // pop：栈底初始状态不可弹出
    if (stack.length <= 1) return stack;
    return this.interner.intern(stack.slice(0, -1));
  }

  /** 在偏移 pos 处按最长匹配 + 优先级挑选规则，无匹配返回 null */
  private matchOne(
    text: string,
    pos: number,
    stateName: StateName,
  ): { rule: CompiledRule; length: number } | null {
    const state = this.states.get(stateName);
    /* istanbul ignore next: 状态名始终来自配置 */
    if (!state) return null;

    let best: { rule: CompiledRule; length: number } | null = null;
    for (const rule of state.rules) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(text);
      if (m === null || m.index !== pos || m[0].length === 0) continue;
      const length = m[0].length;
      if (
        best === null ||
        length > best.length ||
        (length === best.length &&
          (rule.priority > best.rule.priority ||
            (rule.priority === best.rule.priority && rule.order < best.rule.order)))
      ) {
        best = { rule, length };
      }
    }
    return best;
  }

  /**
   * 范围扫描。
   *
   * 每个产出的 token 记录进入前/离开后的状态栈。同步点检查只在 token
   * 边界进行（词法状态只在 token 之间变化）。
   */
  scan(text: string, opts: ScanOptions): ScanResult {
    const { start, hardEnd } = opts;
    let stack = opts.stack;
    let pos = start;
    const out: Token[] = [];
    let synced = false;

    // 前瞻 pos 处的下一个 token（不消费、不改 stack）。
    const peek = (
      at: number,
      st: readonly StateName[],
    ): { type: string; length: number } | null => {
      if (at >= hardEnd) return null;
      const stateName = st[st.length - 1] ?? INITIAL_STATE;
      const hit = this.matchOne(text, at, stateName);
      if (hit === null) return { type: this.errorType, length: 1 };
      return { type: hit.rule.type, length: hit.length };
    };

    const flowFrom = opts.flowFrom ?? start;
    const checkFrom = opts.rightCap ?? 0;
    let flowBroken = false;
    const checkedStart = new Set<number>();
    const checkedEnd = new Set<number>();

    const checkFlow = (
      p: number,
      st: readonly StateName[],
      side: 'start' | 'end',
      type: string,
      tokenStart: number,
    ): void => {
      if (flowBroken || opts.boundaryAligned === undefined || p < flowFrom) return;
      const seen = side === 'start' ? checkedStart : checkedEnd;
      if (seen.has(p)) return;
      seen.add(p);
      const r = opts.boundaryAligned(p, st, side, type, tokenStart);
      if (r === 'diverge') flowBroken = true;
    };
    // 单调游标：endCursor 指向 out 中最后一个 end <= 当前 boundary 的 token。
    // 内部 token 无空隙、按 end 非递减排列，随扫描推进只增不减，总 O(k)。
    let endCursor = -1;
    const endingAt = (boundary: number): string | null => {
      while (
        endCursor + 1 < out.length &&
        (out[endCursor + 1] as Token).end <= boundary
      ) {
        endCursor += 1;
      }
      const t = endCursor >= 0 ? (out[endCursor] as Token) : undefined;
      return t !== undefined && t.end === boundary ? t.type : null;
    };

    const trySync = (boundary: number, st: readonly StateName[]): boolean => {
      if (
        flowBroken ||
        opts.expectedStackAt === undefined ||
        boundary < checkFrom
      ) {
        return false;
      }
      const nxt = peek(boundary, st);
      // 必须传“恰在 boundary 结束”的 token 类型，而非最近消费的任意
      // token —— 二者之间可能隔着 ignore 空隙。
      const prev = endingAt(boundary);
      const expected = opts.expectedStackAt(
        boundary,
        st,
        prev,
        nxt ? nxt.type : null,
        nxt ? nxt.length : null,
      );
      if (expected === null || expected === undefined || st !== expected) {
        return false;
      }
      synced = true;
      return true;
    };

    while (pos < hardEnd) {
      if (trySync(pos, stack)) break;

      const stateName = stack[stack.length - 1] ?? INITIAL_STATE;
      const hit = this.matchOne(text, pos, stateName);

      if (hit === null) {
        // 错误恢复：消费一个码元，状态不变，保证扫描前进。
        const end = pos + 1;
        checkFlow(pos, stack, 'start', this.errorType, pos);
        out.push({
          type: this.errorType,
          value: text.slice(pos, end),
          start: pos,
          end,
          statesBefore: stack,
          statesAfter: stack,
        });
        pos = end;
        checkFlow(pos, stack, 'end', this.errorType, pos - 1);
        if (trySync(pos, stack)) break;
        continue;
      }

      const { rule, length } = hit;
      const end = pos + length;
      const before = stack;
      checkFlow(pos, before, 'start', rule.type, pos);
      if (rule.transition) stack = this.applyTransition(stack, rule.transition);
      // ignore token 也保留在内部 token 流中（词法边界与状态栈需要它们），
      // 公开结果由调用方在输出时统一过滤。
      out.push({
        type: rule.type,
        value: text.slice(pos, end),
        start: pos,
        end,
        statesBefore: before,
        statesAfter: stack,
        ...(rule.ignore ? { ignored: true } : {}),
      });
      pos = end;
      checkFlow(pos, stack, 'end', rule.type, pos - length);
      if (trySync(pos, stack)) break;
    }

    // 到达 hardEnd（EOF）时也允许判定同步（由调用方比较旧 EOF 栈）。
    if (!synced && pos >= hardEnd) {
      synced = trySync(hardEnd, stack);
    }

    return {
      tokens: out,
      end: pos,
      stack,
      synced,
      reachedHardEnd: pos >= hardEnd,
      misaligned: flowBroken,
    };
  }

  /** 全量分词的便捷入口 */
  tokenize(text: string): { tokens: Token[]; stack: readonly StateName[] } {
    const res = this.scan(text, {
      start: 0,
      hardEnd: text.length,
      stack: this.interner.initial(),
    });
    return { tokens: res.tokens, stack: res.stack };
  }
}
