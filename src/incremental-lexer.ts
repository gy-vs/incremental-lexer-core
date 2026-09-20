/**
 * 增量词法分析器
 *
 * 设计要点
 * --------
 * 1. **内部 token 流包含 ignore token**。空白/注释等忽略 token 同样承载词法
 *    边界和状态栈信息，增量重同步必须看到它们；公开的 `tokens` /
 *    `UpdateResult.tokens` 是过滤掉 ignore token 后的视图，复用的对象身份
 *    不变。
 *
 * 2. **编辑批次**：校验（基于旧文本、互不重叠、允许相邻）、排序、从后向前
 *    应用，得到新文本与统一净位移 delta，以及公共前缀长度 cp、公共后缀
 *    起点 sf。三段文本：
 *      - [0, cp]          新旧逐字相同（左稳定区）；
 *      - (cp, sf)         编辑影响区，文本可能不同；
 *      - [sf, newLen)     新旧逐字相同（右稳定区，旧坐标 = 新坐标 - delta）。
 *
 * 3. **重扫与重同步**：从编辑点左侧某个旧 token 边界 L（其进入状态栈已记录
 *    在旧 token 上）开始，对新文本一直扫描到 EOF。扫描在每个 token 边界
 *    （含 ignore 边界）回调同构判定：
 *      - 左稳定区内的边界必须与旧分词同构，否则说明 L 处恢复出的状态栈
 *        无法重现旧分词（编辑的影响越过了 L 左侧），本档失败；
 *      - 编辑影响区内的边界不要求同构（文本已变）；
 *      - 右稳定区内的边界再次要求同构：一旦从 sf 起每个边界连同两侧
 *        token（类型、长度、进入/离开状态栈）都一一对应，即找到重同步点
 *        p，扫描提前结束，p 右侧的旧 token 只整体平移 delta 复用。
 *
 * 4. **有界回退**：第 1 档 L 紧邻编辑（只覆盖含编辑起点的 token）；找不到
 *    重同步点时 L 按几何级（8、16、32…个 token）向左扩大，直到文档起点。
 *    扩大只影响“重扫起点的选择”，不存在“一失败就无条件全量重算”。
 *    `rescannedChars` 逐档累加并对外暴露，可据此验证局部更新。
 *
 * 5. **身份保留**：同步点右侧旧 token 原地平移；重扫窗口左缘那些与旧
 *    token 完全一致（编辑点之前）的 token 也原样回收。
 *
 * 同构判定在旧 token 边界数组（起点严格递增、终点非递减）上二分查找，
 * 局部更新总工作量为 O(重扫 token 数 · log n)，与文档长度无关。
 */

import { LexerEngine } from './engine.js';
import {
  type AffectedRange,
  type Edit,
  type IncrementalLexer,
  type LexerConfig,
  type StateName,
  type Token,
  type UpdateResult,
} from './types.js';

interface NormalizedEdit {
  start: number;
  end: number;
  text: string;
  /** 该编辑自身新内容在新文本中的终点坐标 */
  newEnd: number;
}

/** 第一个 starts[i] >= target 的下标 */
function lowerBound(starts: readonly number[], target: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const isPublic = (t: Token): boolean => !t.ignored;
const stripIgnored = (tokens: readonly Token[]): Token[] => tokens.filter(isPublic);

export class IncrementalLexerImpl implements IncrementalLexer {
  private readonly engine: LexerEngine;
  private _text = '';
  /** 内部 token 流（含 ignore token） */
  private all: Token[] = [];
  /** 公开视图（过滤 ignore） */
  private _tokens: Token[] = [];
  /** 文档末尾的词法状态栈（规范引用） */
  private endStack: readonly StateName[];

  constructor(config: LexerConfig, initialText = '') {
    this.engine = new LexerEngine(config);
    this.endStack = this.engine.interner.initial();
    if (initialText) this.tokenize(initialText);
  }

  get text(): string {
    return this._text;
  }

  get tokens(): Token[] {
    return this._tokens;
  }

  tokenize(text: string): Token[] {
    const { tokens, stack } = this.engine.tokenize(text);
    this._text = text;
    this.all = tokens;
    this._tokens = stripIgnored(tokens);
    this.endStack = stack;
    return this._tokens;
  }

  private normalizeEdits(edits: readonly Edit[]): NormalizedEdit[] {
    const n = this._text.length;
    const list = edits
      .map((e) => {
        if (
          !Number.isInteger(e.start) ||
          !Number.isInteger(e.end) ||
          e.start < 0 ||
          e.end < e.start ||
          e.end > n
        ) {
          throw new Error(
            `非法编辑区间 [${e.start}, ${e.end})：必须满足 0 <= start <= end <= 文本长度(${n})`,
          );
        }
        return { start: e.start, end: e.end, text: e.text ?? '' };
      })
      .sort((a, b) => a.start - b.start || a.end - b.end);

    for (let i = 1; i < list.length; i++) {
      if ((list[i] as NormalizedEdit).start < (list[i - 1] as NormalizedEdit).end) {
        throw new Error('批量编辑不得重叠（相邻/首尾相接允许）');
      }
    }

    // newEnd = 旧起点 + 此前编辑的累积位移 + 本次内容长度；
    // 位移在计算完 newEnd 后才累加。
    let shift = 0;
    for (const e of list) {
      (e as NormalizedEdit & { newEnd: number }).newEnd =
        e.start + shift + e.text.length;
      shift += e.text.length - (e.end - e.start);
    }
    return list as NormalizedEdit[];
  }

  private applyEdits(edits: readonly NormalizedEdit[]): string {
    let out = this._text;
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i] as NormalizedEdit;
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
  }

  private static commonSuffix(a: string, b: string): number {
    let k = 0;
    const max = Math.min(a.length, b.length);
    while (k < max && a.charCodeAt(a.length - 1 - k) === b.charCodeAt(b.length - 1 - k)) {
      k += 1;
    }
    return k;
  }

  private static commonPrefix(a: string, b: string): number {
    let k = 0;
    const max = Math.min(a.length, b.length);
    while (k < max && a.charCodeAt(k) === b.charCodeAt(k)) k += 1;
    return k;
  }

  update(edits: Edit[]): UpdateResult {
    const noEdit: UpdateResult = {
      text: this._text,
      tokens: this._tokens,
      affected: { start: 0, end: 0 },
      rescannedChars: 0,
      attempts: 0,
      fellBack: false,
      resynchronized: true,
      reusedTokens: this._tokens.length,
    };
    if (!Array.isArray(edits) || edits.length === 0) return noEdit;

    const oldText = this._text;
    const oldTokens = this.all; // 内部全量（含 ignore）
    const oldLen = oldText.length;
    const norm = this.normalizeEdits(edits);
    const newText = this.applyEdits(norm);
    const newLen = newText.length;

    const minStart = norm[0]!.start;
    const maxEnd = norm[norm.length - 1]!.end;
    const newLastEnd = norm[norm.length - 1]!.newEnd;
    const delta = newLen - oldLen;

    const starts = oldTokens.map((t) => t.start);

    const cp = IncrementalLexerImpl.commonPrefix(oldText, newText);
    const sf = newLen - IncrementalLexerImpl.commonSuffix(oldText, newText);

    // 旧 token 下标工具（都在有序边界数组上二分）。
    /** 新坐标 p（右稳定区）映射为旧坐标后，恰以该位置为起点的旧 token */
    const oldStartingAt = (oldPos: number): Token | null => {
      const i = lowerBound(starts, oldPos);
      return i < oldTokens.length && starts[i] === oldPos ? (oldTokens[i] as Token) : null;
    };
    /**
     * 恰以 oldPos 为终点的旧 token。内部流无空隙（含 ignore token），
     * 因此“最后一个 start < oldPos 的 token”必以 oldPos 结束（oldPos
     * 为其起点或文档起点时返回 null）。
     */
    const oldEndingAt = (oldPos: number): Token | null => {
      if (oldPos <= 0) return null;
      const i = lowerBound(starts, oldPos) - 1;
      if (i < 0) return null;
      const t = oldTokens[i] as Token;
      return t.end === oldPos ? t : null;
    };

    // 初始左边界（内部 token 流无空隙，首尾相接）：
    //  - 编辑在文档起点（minStart=0）：从文档起点、初始栈开始；
    //  - 否则取包含 minStart 的 token；并额外回退一个 token，以覆盖
    //    “新内容与左侧 token 合并”（如在标识符后紧贴插入字母）的情况。
    const li =
      minStart === 0
        ? -1
        : Math.max(-1, lowerBound(starts, minStart) - 1);

    const initialStackAt = (idx: number): readonly StateName[] =>
      idx >= 0 && idx < oldTokens.length
        ? (oldTokens[idx]!.statesBefore as readonly StateName[])
        : this.engine.interner.initial();

    // 同构判定（不构造全量表，全部 O(log n) 查找）。
    // 左稳定区 [0,cp]：新坐标即旧坐标；右稳定区 [sf,newLen)：旧坐标 p-delta。
    const boundaryAligned = (
      p: number,
      stack: readonly StateName[],
      side: 'start' | 'end',
      tokenType: string,
      tokenStart: number,
    ): boolean | 'diverge' | 'skip' => {
      // 编辑影响区 [cp, sf) 内的边界跳过；与影响区相交的 token（起点在
      // sf 之前），即使终点越过 sf 也跳过 —— 它可能是编辑直接产生/改变的
      // （如脏区中开启、恰好在 sf 处结束的闭合引号），其与旧侧类型不同
      // 不代表右稳定区的分词已分叉。真正的合并点是其后第一个完全位于
      // 右稳定区内的 token 边界。
      if (tokenStart < sf) return 'skip';
      if (p >= cp && p < sf) return 'skip';
      const q = p >= sf ? p - delta : p;
      const tok = side === 'start' ? oldStartingAt(q) : oldEndingAt(q);
      if (tok === null) return 'diverge';
      const st = side === 'start' ? tok.statesBefore : tok.statesAfter;
      return tok.type === tokenType && (st as readonly StateName[]) === stack
        ? true
        : 'diverge';
    };

    // 候选重同步点（p >= sf）：状态栈相等，且 p 前后两个 token 都同构。
    const expectedStackAt = (
      p: number,
      stack: readonly StateName[],
      prevType: string | null,
      nextType: string | null,
      nextLen: number | null,
    ): readonly StateName[] | null => {
      if (p < sf) return null;

      // 前一侧：p 之前最后一个内部 token（含 ignore）必须在 p 处结束。
      let prevOk: boolean;
      if (p === newLen) {
        prevOk = stack === this.endStack;
        const lastTok = oldEndingAt(oldLen);
        if (prevOk) {
          prevOk = (lastTok?.type ?? null) === prevType;
        }
      } else {
        const q = p - delta;
        const endTok = oldEndingAt(q);
        prevOk =
          endTok !== null &&
          endTok.type === prevType &&
          (endTok.statesAfter as readonly StateName[]) === stack;
      }
      if (!prevOk) return null;

      // 后一侧：p 处开始的下一个 token（前瞻）必须同类型、同长度、同进入栈。
      if (p === newLen) {
        return nextType === null ? stack : null;
      }
      const q = p - delta;
      const startTok = oldStartingAt(q);
      if (nextType === null || startTok === null) return null;
      if (
        startTok.type !== nextType ||
        startTok.end - startTok.start !== nextLen ||
        (startTok.statesBefore as readonly StateName[]) !== stack
      ) {
        return null;
      }
      return stack;
    };

    // ---- 分档回退重扫 ----
    const INITIAL_PAD = 8;
    let pad = INITIAL_PAD;
    let attempts = 0;
    let rescannedChars = 0;
    let winTokens: Token[] = [];
    let winEnd = 0;
    let winStack = this.endStack;
    let synced = false;
    let leftIdx = li;

    for (;;) {
      attempts += 1;
      const aNew = leftIdx >= 0 ? starts[leftIdx]! : 0;

      const res = this.engine.scan(newText, {
        start: aNew,
        hardEnd: newLen,
        stack: initialStackAt(leftIdx),
        // 流校验从扫描起点开始（左稳定区要求同构）；
        // 同步候选只在右稳定区（sf）与编辑内容之后询问。
        flowFrom: aNew,
        rightCap: Math.max(sf, newLastEnd),
        expectedStackAt,
        boundaryAligned,
      });
      rescannedChars += res.end - aNew;
      winTokens = res.tokens;
      winEnd = res.end;
      winStack = res.stack;
      synced = res.synced;

      if (synced || leftIdx < 0) break;

      const nextIdx = leftIdx > 0 ? Math.max(0, leftIdx - pad) : -1;
      if (nextIdx === leftIdx) break;
      leftIdx = nextIdx;
      pad *= 2;
    }

    // ---- 回收窗口左缘、在编辑起点之前与旧 token 完全一致的对象 ----
    let reclaim = 0;
    for (let k = 0; k < winTokens.length; k++) {
      const oldIdx = leftIdx + k;
      if (oldIdx < 0 || oldIdx >= oldTokens.length) break;
      const fresh = winTokens[k]!;
      if (fresh.end > minStart) break; // 不得越过最早编辑起点
      if (synced && fresh.end >= winEnd) break; // 不得越过同步点
      const old = oldTokens[oldIdx]!;
      if (
        fresh.type !== old.type ||
        fresh.value !== old.value ||
        fresh.start !== old.start ||
        fresh.end !== old.end
      ) {
        break;
      }
      reclaim += 1;
    }

    // ---- 同步点右侧的旧内部 token：原地平移 delta，身份不变 ----
    let suffixIdx = oldTokens.length;
    if (synced && winEnd - delta < oldLen) {
      const q = winEnd - delta;
      const idx = lowerBound(starts, q);
      if (idx < oldTokens.length && starts[idx] === q) suffixIdx = idx;
    }

    const aOld = leftIdx >= 0 ? starts[leftIdx]! : 0;
    const reclaimedEnd =
      reclaim > 0 ? (oldTokens[leftIdx + reclaim - 1] as Token).end : aOld;

    const merged: Token[] = [];
    for (let k = 0; k < leftIdx; k++) merged.push(oldTokens[k]!);
    for (let k = 0; k < reclaim; k++) merged.push(oldTokens[leftIdx + k]!);
    for (let k = reclaim; k < winTokens.length; k++) merged.push(winTokens[k]!);
    for (let k = suffixIdx; k < oldTokens.length; k++) {
      const t = oldTokens[k]!;
      t.start += delta;
      t.end += delta;
      merged.push(t);
    }

    // 受影响范围按“公开 token”坐标给出：忽略空白若正好夹在同步点与下一个
    // 公开 token 之间，会被随后缀一起平移复用，不应计入受影响区间，因此
    // end 取下一个“非 ignore”旧 token 的起点（平移后）。
    let affectedEnd = newLen;
    if (suffixIdx < oldTokens.length) {
      let k = suffixIdx;
      while (k < oldTokens.length && (oldTokens[k] as Token).ignored) k += 1;
      if (k < oldTokens.length) affectedEnd = (starts[k] as number) + delta;
    }
    const affected: AffectedRange = { start: reclaimedEnd, end: affectedEnd };

    // 复用计数按公开 token 统计
    const publicCount = (from: number, to: number): number => {
      let c = 0;
      for (let k = from; k < to; k++) if (!(oldTokens[k] as Token).ignored) c += 1;
      return c;
    };
    const reusedTokens =
      publicCount(0, Math.max(0, leftIdx)) +
      publicCount(leftIdx, leftIdx + reclaim) +
      publicCount(suffixIdx, oldTokens.length);

    this._text = newText;
    this.all = merged;
    this._tokens = stripIgnored(merged);
    if (suffixIdx >= oldTokens.length) this.endStack = winStack;

    return {
      text: newText,
      tokens: this._tokens,
      affected,
      rescannedChars,
      attempts,
      fellBack: attempts > 1,
      resynchronized: synced,
      reusedTokens,
    };
  }
}
