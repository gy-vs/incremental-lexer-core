/**
 * 公开类型定义
 */

/** 词法规则名 / token 类型名 */
export type TokenType = string;

/** 词法状态名（`"$"` 为内置初始/全局状态，`"$mode"` 为 mode 栈顶模式） */
export type StateName = string;

/** 内置初始状态名 */
export const INITIAL_STATE: StateName = '$';

/**
 * 一条词法规则。
 *
 * 匹配语义：在当前偏移处依次尝试当前状态的所有规则，取匹配长度最长者；
 * 长度相同时 priority 更大者胜出；仍然相同则声明靠前者胜出。
 */
export interface LexerRule {
  /** 命中后生成的 token 类型 */
  type: TokenType;
  /**
   * 匹配模式。构建时会强制改写为 sticky（`y`）正则：
   * 去掉 `g` 标志、加上 `y` 标志。模式中可以使用 `[\s\S]` 等手段跨行匹配。
   */
  pattern: RegExp;
  /**
   * 长度相同时的优先级，数字越大越优先，默认 0。
   */
  priority?: number;
  /**
   * 命中后切换词法状态（在 emit 之前应用）。
   * - 字符串 / `{ push: name }`：把状态压栈，后续在该状态中分词；
   * - `{ pop: true }`：弹出栈顶状态（栈底的初始状态不可被弹出）；
   * - `{ mode: name }`：把栈顶替换为该状态（不改变栈深度）；
   * - 不写：保持当前状态。
   *
   * 切换发生在该 token 之后，因此 token 自身的 `statesBefore` / `statesAfter`
   * 可用于观察这一变化。
   */
  next?: StateName | StateTransition;
  /**
   * 命中后只消费文本、不产出 token（例如空白、注释若不希望出现在结果里）。
   * 状态切换依然会执行。
   */
  ignore?: boolean;
}

export type StateTransition =
  | { push: StateName }
  | { pop: true }
  | { mode: StateName };

/**
 * 一个词法状态。规则按数组顺序声明。
 */
export interface LexerState {
  name: StateName;
  rules: LexerRule[];
}

export interface LexerConfig {
  /** 状态表，必须包含 {@link INITIAL_STATE}（`"$"`）。 */
  states: Record<StateName, LexerState>;
  /**
   * 任意规则都无法匹配时生成的错误 token 类型，默认 `"error"`。
   * 错误 token 恰好消费一个 UTF-16 码元，随后重新尝试所有规则，
   * 因此分词永远不会卡住。
   */
  errorType?: TokenType;
}

/**
 * 一个 token。
 *
 * `start` / `end` 是 UTF-16 码元偏移（与字符串索引、`String#slice` 一致）。
 * `statesBefore` / `statesAfter` 是进入该 token 之前 / 离开该 token 之后的
 * 词法状态栈（栈底在前），供增量重同步判定与外部调试使用。
 * 增量更新复用旧 token 时，这两个数组引用保持不变。
 */
export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  /** @internal 由内核写入；对调用方只读 */
  statesBefore?: readonly StateName[];
  /** @internal 由内核写入；对调用方只读 */
  statesAfter?: readonly StateName[];
  /** @internal 是否为 ignore token（内部保留以维护词法边界，公开结果中过滤） */
  ignored?: boolean;
}

/**
 * 一批提交的编辑之一，坐标基于编辑前的旧文本。
 * 批量编辑不得重叠；相邻（首尾相接）允许。
 */
export interface Edit {
  start: number;
  end: number;
  /** 替换 `[start, end)` 的新文本；省略 / 空串表示删除 */
  text?: string;
}

/** 增量更新后受影响的新区间（新文本坐标） */
export interface AffectedRange {
  start: number;
  end: number;
}

export interface UpdateResult {
  /** 编辑并重新分词后的完整文本 */
  text: string;
  /** 编辑后的完整 token 序列 */
  tokens: Token[];
  /**
   * 受影响范围（新坐标）：该区间内的 token 是重新扫描产生的，
   * 区间外的 token 全部沿用旧对象身份。
   */
  affected: AffectedRange;
  /**
   * 本次实际重新扫描过的新文本字符数（UTF-16 码元）。
   * 用于验证局部更新：典型小编辑时该数字远小于文档长度；
   * 只有状态无法在编辑点附近重新同步、逐档回退扩大范围时才会变大。
   */
  rescannedChars: number;
  /**
   * 重新扫描尝试次数。第 1 次为最小范围；之后每向两侧扩大一档加 1。
   */
  attempts: number;
  /** 是否发生过“无法在当前边界重新同步、回退扩大范围” */
  fellBack: boolean;
  /** 是否最终找到了重新同步点（文档结尾始终是合法同步点） */
  resynchronized: boolean;
  /** 原样复用对象身份的未受影响 token 数量 */
  reusedTokens: number;
}

/** 增量词法分析器 */
export interface IncrementalLexer {
  /** 当前完整文本 */
  readonly text: string;
  /** 当前完整 token 序列（请勿原地修改） */
  readonly tokens: Token[];
  /** 对整段文本分词（创建或全量重建），返回 token 序列 */
  tokenize(text: string): Token[];
  /**
   * 提交一批基于旧文本坐标、互不重叠的编辑，
   * 返回新 token 序列、受影响范围与本次重新扫描统计。
   */
  update(edits: Edit[]): UpdateResult;
}

/** 工厂函数 */
export function createLexer(_config: LexerConfig): IncrementalLexer {
  throw new Error('createLexer 由 ./incremental-lexer 提供，请从包入口导入');
}
