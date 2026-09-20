/**
 * 内核测试：node --test 运行（无需第三方依赖）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLexer,
  INITIAL_STATE,
  type Edit,
  type IncrementalLexer,
  type LexerConfig,
  type Token,
} from '../src/index.js';

/* ------------------------------------------------------------------ */
/* 测试用规则配置：                                                     */
/*  - 最长匹配（`//` 优先于 `/`，`==` 优先于 `=`）                     */
/*  - 优先级（关键字 if/else 与标识符等长时胜出）                        */
/*  - 词法状态切换（双引号字符串 push/pop，可跨行；块注释状态）          */
/* ------------------------------------------------------------------ */

function makeConfig(): LexerConfig {
  return {
    errorType: 'error',
    states: {
      [INITIAL_STATE]: {
        name: INITIAL_STATE,
        rules: [
          { type: 'ws', pattern: /[ \t\r\n]+/, ignore: true },
          { type: 'line-comment', pattern: /\/\/[^\n]*/, ignore: true },
          { type: 'block-open', pattern: /\/\*/, next: { push: 'blockComment' } },
          { type: 'string-open', pattern: /"/, next: { push: 'doubleString' } },
          { type: 'number', pattern: /\d+(?:\.\d+)?/ },
          { type: 'keyword', pattern: /if|else|return/, priority: 2 },
          { type: 'bool', pattern: /true|false/, priority: 1 },
          { type: 'ident', pattern: /[A-Za-z_]\w*/, priority: 0 },
          { type: 'op', pattern: /==|!=|<=|>=|\+\+|--|&&|\|\|/ },
          { type: 'op', pattern: /[+\-*/=<>!&|(){};.,]/ },
        ],
      },
      doubleString: {
        name: 'doubleString',
        rules: [
          { type: 'string-close', pattern: /"/, next: { pop: true } },
          { type: 'string-escape', pattern: /\\[\s\S]/ },
          { type: 'string-body', pattern: /[^"\\]+/ },
        ],
      },
      blockComment: {
        name: 'blockComment',
        rules: [
          { type: 'block-close', pattern: /\*\//, next: { pop: true }, ignore: true },
          { type: 'comment-stars', pattern: /\*+(?!\/)/, ignore: true },
          { type: 'comment-body', pattern: /[^*]+/, ignore: true },
        ],
      },
    },
  };
}

function makeLexer(text = ''): IncrementalLexer {
  return createLexer(makeConfig(), text);
}

/** 全量分词（对照基准），只保留对外可见字段 */
function scratch(text: string): Token[] {
  return makeLexer(text).tokens.map((t) => ({
    type: t.type,
    value: t.value,
    start: t.start,
    end: t.end,
  }));
}

function plain(tokens: Token[]) {
  return tokens.map((t) => ({
    type: t.type,
    value: t.value,
    start: t.start,
    end: t.end,
  }));
}

function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.start) + (e.text ?? '') + text.slice(e.end);
}

function applyEdits(text: string, edits: Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => applyEdit(acc, e), text);
}

function assertCoversText(text: string, tokens: Token[]) {
  let prev = 0;
  for (const t of tokens) {
    assert.ok(t.start >= prev && t.end > t.start, `token 区间非法: ${JSON.stringify(t)}`);
    assert.equal(t.value, text.slice(t.start, t.end));
    prev = t.end;
  }
  assert.ok(prev <= text.length);
}

/* ------------------------------------------------------------------ */
/* 1. 规则语义：最长匹配与优先级                                         */
/* ------------------------------------------------------------------ */

describe('规则：最长匹配与优先级', () => {
  it('关键字与标识符等长时按优先级，多字符运算符按最长匹配', () => {
    const tokens = makeLexer('if iff == = // hi\n / x true').tokens;
    const types = tokens.map((t) => t.type);
    assert.deepEqual(types, [
      'keyword', // if（priority 2 > ident 0）
      'ident', // iff
      'op', // ==（长于 =）
      'op', // =
      'op', // /（// 已被行注释吃掉，这里是单独的 /）
      'ident', // x
      'bool', // true（priority 1 > ident 0）
    ]);
  });

  it('无任何规则匹配时产出 error token 且不卡死', () => {
    const lexer = makeLexer('a@b');
    const types = lexer.tokens.map((t) => t.type);
    assert.deepEqual(types, ['ident', 'error', 'ident']);
    assert.equal(lexer.tokens[1]!.value, '@');
  });
});

/* ------------------------------------------------------------------ */
/* 2. 跨 token 编辑：身份保留、仅平移、局部重扫                          */
/* ------------------------------------------------------------------ */

describe('跨 token 编辑', () => {
  it('编辑点两侧 token 保留对象身份，右侧仅坐标平移，重扫字符数局部', () => {
    const text = 'alpha beta gamma delta epsilon zeta';
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    assert.equal(before[1]!.value, 'beta');

    // 左侧旧 token 身份保留；右侧旧 token 身份保留且平移 +2。
    // 注意旧坐标必须在 update 之前快照：后缀 token 是原地平移的同一对象。
    const gammaBefore = before.find((t) => t.value === 'gamma') as Token;
    const gammaOldStart = gammaBefore.start;
    const gammaOldEnd = gammaBefore.end;
    const res = lexer.update([{ start: 6, end: 10, text: 'betaxx' }]);
    assert.equal(res.text, 'alpha betaxx gamma delta epsilon zeta');

    // 结果与全量分词一致
    assert.deepEqual(plain(res.tokens), scratch(res.text));

    // 左侧旧 token 身份保留；右侧旧 token 身份保留且平移 +2
    assert.equal(res.tokens[0], before[0]);
    const gamma = res.tokens.find((t) => t.value === 'gamma')!;
    assert.equal(gamma, gammaBefore);
    assert.equal(gamma.start, gammaOldStart + 2);
    assert.equal(gamma.end, gammaOldEnd + 2);

    // 受影响范围只覆盖被改 token；统计局部
    assert.equal(res.affected.start, 6);
    assert.equal(res.affected.end, 13);
    assert.equal(res.resynchronized, true);
    assert.ok(
      res.rescannedChars < 30,
      `rescannedChars=${res.rescannedChars} 应远小于全文长度 ${res.text.length}`,
    );
    assert.equal(res.reusedTokens, before.length - 1);
  });

  it('删除使文本缩短时右侧 token 负向平移', () => {
    const text = 'aaa bbbb ccccc';
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    const cOld = before[2]!;
    const cOldStart = cOld.start;
    const res = lexer.update([{ start: 4, end: 8 }]); // 删 bbbb
    assert.equal(res.text, 'aaa  ccccc');
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    const c = res.tokens.find((t) => t.value === 'ccccc')!;
    assert.equal(c, cOld);
    assert.equal(c.start, cOldStart - 4);
  });

  it('插入落在 token 边界之间（ignore 空隙）也只做最小重扫', () => {
    const text = 'a b c';
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    const res = lexer.update([{ start: 2, end: 2, text: 'x' }]); // 在 b 前插 x：a xb c
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    assert.equal(res.tokens[0], before[0]);
    assert.ok(res.rescannedChars <= 6);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 词法状态切换                                                      */
/* ------------------------------------------------------------------ */

describe('词法状态切换', () => {
  it('字符串内按 doubleString 状态分词，闭合后回到初始状态', () => {
    const lexer = makeLexer('x = "ab\\"cd" + y');
    const types = lexer.tokens.map((t) => t.type);
    assert.deepEqual(types, [
      'ident',
      'op',
      'string-open',
      'string-body', // ab
      'string-escape', // \"
      'string-body', // cd
      'string-close',
      'op',
      'ident',
    ]);
    // 闭合后确实回到初始状态
    const close = lexer.tokens.find((t) => t.type === 'string-close')!;
    assert.deepEqual(close.statesAfter, [INITIAL_STATE]);
  });

  it('mode 切换只替换栈顶状态（不改变栈深度），pop 能正确回到外层状态', () => {
    const cfg: LexerConfig = {
      errorType: 'error',
      states: {
        [INITIAL_STATE]: {
          name: INITIAL_STATE,
          rules: [
            { type: 'ws', pattern: /\s+/, ignore: true },
            { type: 'enter', pattern: /<\?/, next: { push: 'code' } },
            { type: 'id', pattern: /\w+/ },
          ],
        },
        code: {
          name: 'code',
          rules: [
            { type: 'str-open', pattern: /'/, next: { mode: 'sqstr' } },
            { type: 'exit', pattern: /\?>/, next: { pop: true } },
            { type: 'cid', pattern: /[A-Za-z]+/ },
            { type: 'ws2', pattern: /\s+/, ignore: true },
          ],
        },
        // sqstr 是 code 的“模式替换”：进入时栈仍为 ['$','code']，
        // 只是栈顶名字变成 sqstr；闭合时 pop 回到 '$'。
        sqstr: {
          name: 'sqstr',
          rules: [
            { type: 'str-close', pattern: /'/, next: { mode: 'code' } },
            { type: 'str-body', pattern: /[^']+/ },
          ],
        },
      },
    };
    const lexer = createLexer(cfg, "<? a 'hi' ?> b");
    const open = lexer.tokens.find((t) => t.type === 'str-open')!;
    const body = lexer.tokens.find((t) => t.type === 'str-body')!;
    const close = lexer.tokens.find((t) => t.type === 'str-close')!;
    // 进入字符串时栈顶被替换、深度不增加
    assert.deepEqual(open.statesAfter, [INITIAL_STATE, 'sqstr']);
    assert.deepEqual(body.statesBefore, [INITIAL_STATE, 'sqstr']);
    // 闭合恢复为 code（而非直接回初始状态）
    assert.deepEqual(close.statesAfter, [INITIAL_STATE, 'code']);
    // ?> 才真正 pop 回初始状态
    const exit = lexer.tokens.find((t) => t.type === 'exit')!;
    assert.deepEqual(exit.statesAfter, [INITIAL_STATE]);
  });

  it('块注释状态跨行，结束后正常恢复', () => {
    const lexer = makeLexer('a /* x \n y */ b');
    assert.deepEqual(plain(lexer.tokens), scratch('a /* x \n y */ b'));
    const b = lexer.tokens[lexer.tokens.length - 1]!;
    assert.equal(b.value, 'b');
    assert.deepEqual(b.statesBefore, [INITIAL_STATE]);
  });

  it('一批编辑同时插入开/闭引号：状态切换后在闭合处重新同步', () => {
    const text = 'aa bb cc dd ee';
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    // 在 bb 两侧各插一个引号（一批两个编辑）
    const res = lexer.update([
      { start: 3, end: 3, text: '"' },
      { start: 5, end: 5, text: '"' },
    ]);
    assert.equal(res.text, 'aa "bb" cc dd ee');
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    const types = res.tokens.map((t) => t.type);
    assert.ok(types.includes('string-open'));
    assert.ok(types.includes('string-close'));
    // 闭合点之后的 cc dd ee 身份保留
    const cc = res.tokens.find((t) => t.value === 'cc')!;
    assert.equal(cc, before.find((t) => t.value === 'cc'));
  });
});

/* ------------------------------------------------------------------ */
/* 4. 可跨行字符串                                                       */
/* ------------------------------------------------------------------ */

describe('多行字符串', () => {
  const text = 'x = "line1\nline2\nline3"; y = 9';

  it('字符串体跨多行仍是连续 token', () => {
    const lexer = makeLexer(text);
    const body = lexer.tokens.find((t) => t.type === 'string-body')!;
    assert.ok(body.value.includes('\n'));
    assert.deepEqual(plain(lexer.tokens), scratch(text));
  });

  it('在多行字符串内部编辑不破坏同步，后续 token 全部复用', () => {
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    const idx = text.indexOf('line2');
    const res = lexer.update([{ start: idx, end: idx + 5, text: 'LINE_TWO' }]);
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    const y = res.tokens.find((t) => t.value === 'y')!;
    assert.equal(y, before.find((t) => t.value === 'y'));
    const num = res.tokens.find((t) => t.value === '9')!;
    assert.equal(num, before.find((t) => t.value === '9'));
  });
});

/* ------------------------------------------------------------------ */
/* 5. 相邻批量编辑                                                      */
/* ------------------------------------------------------------------ */

describe('相邻批量编辑', () => {
  it('首尾相接的一批编辑一次性应用且结果等价于全量分词', () => {
    const text = 'a b c d e';
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    // [1,2) 空格替换、[2,3) b 替换：相邻编辑
    const batch: Edit[] = [
      { start: 1, end: 2, text: '  ' },
      { start: 2, end: 3, text: 'bb' },
      { start: 6, end: 7, text: 'ddd' },
    ];
    const res = lexer.update(batch);
    assert.equal(res.text, applyEdits(text, batch));
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    // e 远离编辑区，身份保留
    assert.equal(res.tokens.find((t) => t.value === 'e'), before[4]);
  });

  it('拒绝重叠编辑', () => {
    const lexer = makeLexer('abcdef');
    assert.throws(() =>
      lexer.update([
        { start: 0, end: 3 },
        { start: 2, end: 5 },
      ]),
    );
  });

  it('拒绝越界与非法区间', () => {
    const lexer = makeLexer('abcdef');
    assert.throws(() => lexer.update([{ start: 3, end: 2 }]));
    assert.throws(() => lexer.update([{ start: 0, end: 99 }]));
  });
});

/* ------------------------------------------------------------------ */
/* 6. 失败恢复与回退扩大范围                                              */
/* ------------------------------------------------------------------ */

describe('失败恢复', () => {
  it('错误字符不阻断后续增量编辑', () => {
    const lexer = makeLexer('a @ b');
    const res = lexer.update([{ start: 4, end: 5, text: 'ccc' }]);
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    assert.equal(res.tokens.filter((t) => t.type === 'error').length, 1);
  });

  it('编辑落在多行字符串状态内：右扩扫描在闭合引号处合并，外侧 token 复用', () => {
    // 文档中部有一个跨多行的字符串。向字符串体内插入一段自包含的文本
    // （不引入未配对引号）：编辑点旧栈为 doubleString，新内容之后仍为
    // doubleString，状态不切换，直到旧闭引号处双方都 pop 回初始状态 ——
    // 合并点远离编辑点，初始小窗口需要向右扫描越过整个字符串体。
    const head = Array.from({ length: 20 }, (_, i) => `h${i}`).join(' ');
    const tail = Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ');
    const text = `${head} "line1\nline2\nline3" ${tail}`;
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    const t0Before = before.find((t) => t.value === 't0') as Token;
    const t0BeforeStart = t0Before.start; // 必须在 update 前快照（后缀原地平移）
    const idx = text.indexOf('line2');
    const res = lexer.update([{ start: idx, end: idx, text: 'INS' }]);
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    assert.equal(res.resynchronized, true);
    assert.ok(res.rescannedChars < res.text.length, `rescannedChars=${res.rescannedChars}`);
    // 字符串闭合点之后的全部尾巴保留身份（仅平移）
    const t0 = res.tokens.find((t) => t.value === 't0')!;
    assert.equal(t0, t0Before);
    assert.equal(t0.start - t0BeforeStart, 'INS'.length);
    // 闭合引号由重扫窗口产出（同步点位于 sb/sc 边界），验证其存在且
    // 闭合后回到初始状态；真正复用的是它之后的全部尾巴。
    const close = res.tokens.find((t) => t.type === 'string-close')!;
    assert.deepEqual(close.statesAfter, [INITIAL_STATE]);
    // 字符串体确实跨行
    assert.ok(res.tokens.some((t) => t.type === 'string-body' && t.value.includes('\n')));
  });

  it('状态无法在编辑点附近同步时逐档回退扩大范围，而非静默给出错误结果', () => {
    // 插入一个永不闭合的引号：直到 EOF 都处于字符串状态，
    // 即使文本逐字相同，旧文档的 EOF 处于初始状态，状态栈无法相等，
    // 于是逐档回退扩大窗口直至文档起点（扩大是有限的、有统计暴露，而非无条件全量）。
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    const text = `${words} tail`;
    const lexer = makeLexer(text);
    const before = lexer.tokens;
    const res = lexer.update([{ start: 20, end: 20, text: '"' }]);

    assert.deepEqual(plain(res.tokens), scratch(res.text));
    assert.equal(res.fellBack, true);
    assert.equal(res.resynchronized, false);
    assert.ok(res.attempts >= 2, `attempts=${res.attempts}`);
    // 回退是有代价的：重扫范围被扩大到文档起点
    assert.ok(res.rescannedChars >= res.text.length);
    // 但确实只发生在无法同步时；对比普通编辑：1 次、局部代价。
    // （把 w4 换成单字符 X，分词数少 1 属正常；关键是只局部重扫。）
    const lexer2 = makeLexer(text);
    const local = lexer2.update([{ start: 20, end: 22, text: 'X' }]);
    assert.equal(local.attempts, 1);
    assert.equal(local.resynchronized, true);
    assert.ok(local.rescannedChars < 40);
    assert.equal(local.tokens.length, before.length - 1);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 十万 token 文档                                                    */
/* ------------------------------------------------------------------ */

describe('十万 token 文档', () => {
  it('局部编辑为 O(局部) 规模，绝大多数 token 身份保留', () => {
    const words = Array.from({ length: 100_000 }, (_, i) => `w${i}`);
    const text = words.join(' ');
    const lexer = makeLexer(text);
    assert.equal(lexer.tokens.length, 100_000);

    const mid = text.indexOf('w50000');
    const before = lexer.tokens;
    const t0 = process.hrtime.bigint();
    const res = lexer.update([{ start: mid, end: mid + 6, text: 'CHANGED' }]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.equal(res.tokens.length, 100_000);
    assert.deepEqual(plain(res.tokens), scratch(res.text));
    assert.equal(res.tokens[0], before[0]);
    assert.equal(res.tokens[res.tokens.length - 1], before[before.length - 1]);
    assert.ok(res.reusedTokens > 99_990, `reusedTokens=${res.reusedTokens}`);
    assert.ok(res.rescannedChars < 1000, `rescannedChars=${res.rescannedChars}`);
    assert.ok(ms < 500, `增量更新耗时 ${ms.toFixed(1)}ms 应远小于全量重扫`);
  });
});

/* ------------------------------------------------------------------ */
/* 8. 随机模糊：任意编辑序列后增量结果恒等于全量分词                      */
/* ------------------------------------------------------------------ */

describe('模糊测试', () => {
  it('100 轮随机单/双编辑，增量结果与全量一致、token 覆盖合法', () => {
    const alphabet = ['abc', ' ', 'x1', '  ', '"', '12', '+', '\n', '/', 'z'];
    let text = Array.from({ length: 40 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join('');
    const lexer = makeLexer(text);

    for (let round = 0; round < 100; round++) {
      const edits: Edit[] = [];
      const cuts = [
        Math.floor(Math.random() * (text.length + 1)),
        Math.floor(Math.random() * (text.length + 1)),
      ].sort((a, b) => a - b);
      edits.push({
        start: cuts[0]!,
        end: cuts[0]! + Math.floor(Math.random() * 3),
        text: alphabet[Math.floor(Math.random() * alphabet.length)],
      });
      // 约束 end 不越界
      edits[0]!.end = Math.min(edits[0]!.end, text.length);
      if (Math.random() < 0.5 && cuts[1]! >= edits[0]!.end) {
        edits.push({
          start: cuts[1]!,
          end: Math.min(cuts[1]! + Math.floor(Math.random() * 3), text.length),
          text: alphabet[Math.floor(Math.random() * alphabet.length)],
        });
      }

      try {
        const res = lexer.update(edits);
        text = res.text;
        assert.deepEqual(plain(res.tokens), scratch(text), `第 ${round} 轮结果不一致`);
        assertCoversText(text, res.tokens);
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
        // 唯一允许的异常是重叠/非法编辑（两个随机区间可能重叠）
        assert.match((err as Error).message, /不得重叠|非法编辑/);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 9. 空编辑与全量语义                                                    */
/* ------------------------------------------------------------------ */

describe('杂项', () => {
  it('空编辑批次不产生任何重扫，token 数组原引用返回', () => {
    const lexer = makeLexer('a b c');
    const ref = lexer.tokens;
    const res = lexer.update([]);
    assert.equal(res.tokens, ref);
    assert.equal(res.rescannedChars, 0);
    assert.equal(res.attempts, 0);
    assert.equal(res.reusedTokens, 3);
  });

  it('空文档上插入后再删除可回到空结果', () => {
    const lexer = makeLexer('');
    const r1 = lexer.update([{ start: 0, end: 0, text: 'if x' }]);
    assert.deepEqual(plain(r1.tokens), scratch('if x'));
    const r2 = lexer.update([{ start: 0, end: 4, text: '' }]);
    assert.equal(r2.tokens.length, 0);
    assert.equal(r2.text, '');
  });

  it('tokenize 可全量重建并清除增量状态', () => {
    const lexer = makeLexer('a b');
    lexer.update([{ start: 0, end: 1, text: 'zzz' }]);
    const tokens = lexer.tokenize('q w e');
    assert.deepEqual(plain(tokens), scratch('q w e'));
    assert.equal(lexer.text, 'q w e');
  });
});
