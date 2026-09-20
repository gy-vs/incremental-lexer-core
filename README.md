# incremental-lexer-core

可配置规则的**增量词法分析内核**（TypeScript，零运行时依赖）。

调用方先对整段文本分词，之后提交基于**旧文本坐标**的一批互不重叠编辑，
内核返回新的 token 序列、受影响范围，以及本次重新扫描的字符数。
未受影响的 token 保留对象身份，仅整体平移位置。不含编辑器/UI。

- 规则：**最长匹配** + 等长时 `priority`（再相同取声明靠前者）
- 词法状态：`push` / `pop` / `mode`（替换栈顶）状态栈，状态栈驻留后以
  引用相等做 O(1) 重同步判定
- 支持**跨行 token**（正则可匹配换行，如多行字符串/块注释）
- 增量更新向两侧扩展到稳定边界；状态无法就近重新同步时按几何级
  **有界回退扩大范围**，但不会无条件全量重算
- 公开 `rescannedChars` / `attempts` / `fellBack` / `resynchronized`
  / `reusedTokens` 用于验证局部更新

## 安装与构建

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsc + node --test
```

Node.js 20+，ESM。

## 快速开始

```ts
import { createLexer, INITIAL_STATE } from 'incremental-lexer-core';

const lexer = createLexer({
  errorType: 'error',
  states: {
    [INITIAL_STATE]: {
      name: INITIAL_STATE,
      rules: [
        { type: 'ws', pattern: /\s+/, ignore: true },
        { type: 'str-open', pattern: /"/, next: { push: 'string' } },
        { type: 'keyword', pattern: /if|else/, priority: 2 },
        { type: 'ident', pattern: /[A-Za-z_]\w*/ },
        { type: 'op', pattern: /==|!=|[+\-*/=]/ }, // 多字符运算符按最长匹配胜出
      ],
    },
    string: {
      name: 'string',
      rules: [
        { type: 'str-close', pattern: /"/, next: { pop: true } },
        { type: 'str-escape', pattern: /\\[\s\S]/ },
        // [\s\S] 使字符串体可跨行
        { type: 'str-body', pattern: /[^"\\]+/ },
      ],
    },
  },
});

// 1) 全量分词
lexer.tokenize('alpha = "a\nb"');

// 2) 提交一批基于旧文本坐标、互不重叠（允许相邻）的编辑
const r = lexer.update([
  { start: 0, end: 5, text: 'beta' },
  { start: 8, end: 8, text: 'x' },
]);

r.tokens;          // 新 token 序列（ignore token 不出现）
r.affected;        // 受影响的新区间（新坐标）
r.rescannedChars;  // 本次重新扫描过的字符数 —— 局部小编辑时远小于文档长度
r.attempts;        // 重扫尝试次数（1 = 最小窗口一次命中）
r.fellBack;        // 是否发生过回退扩大范围
r.resynchronized;  // 是否找到了重同步点
r.reusedTokens;    // 原样复用身份的 token 数量
```

## 规则字段

```ts
interface LexerRule {
  type: string;
  pattern: RegExp;                    // 构建时强制改为 sticky(y)
  priority?: number;                  // 等长匹配时更大者胜出，默认 0
  next?: StateName | { push: string } | { pop: true } | { mode: string };
  ignore?: boolean;                   // 消费但不产出 token（空白/注释等）
}
```

任意规则都不匹配时产出一个单字符 `errorType`（默认 `"error"`）token，
随后继续，保证分词永不卡住。

## 增量算法

1. 校验并排序编辑批次，从后向前应用，得到新文本、净位移 `delta`、
   公共前缀长度 `cp` 与公共后缀起点 `sf`：
   - `[0, cp)` 左右文本逐字相同（左稳定区）
   - `[cp, sf)` 编辑影响区
   - `[sf, end)` 左右文本逐字相同（右稳定区，旧坐标 = 新坐标 − delta）
2. 从编辑点左侧一个旧 token 边界（其进入状态栈记录在旧 token 上）起，
   对新文本扫描到 EOF。扫描在每个 token 边界（含 ignore 边界）做同构检查：
   - 右稳定区内要求**位置 + 类型 + 长度 + 进入/离开状态栈**全部一致，
     且边界前后两个 token 也一致——此时该点即重同步点，扫描提前停止，
     右侧旧 token 原地平移 `delta` 复用；
   - 编辑影响区内的边界不参与判定；
   - 与影响区相交的 token（起点在 `sf` 之前）同样跳过，其结束点
     不代表右稳定区已分叉。
3. 找不到重同步点时（例如编辑插入了永不闭合的引号），扫描起点按
   8、16、32… 个 token 几何级**向左回退扩大**，直到文档起点。
   扩大是有界且逐档发生的，`rescannedChars` 随之增长——这正是
   “不能无条件全量重算”的可观测保证。
4. 重扫窗口左缘那些与旧 token 完全一致且位于编辑点之前的 token 会被
   原样回收（同样保留身份）。

内核内部保留 ignore token（它们承载词法边界与状态栈），公开的
`tokens` 是过滤后的视图。同构判定全部在有序边界数组上二分完成，
局部更新工作量为 O(重扫 token 数 · log n)，与文档长度无关。

## 测试覆盖

- 最长匹配 / 优先级 / 错误恢复
- 跨 token 编辑的身份保留与仅平移
- `push/pop/mode` 状态切换、跨行字符串与块注释
- 相邻批量编辑、重叠/越界编辑拒绝
- 未闭合引号的失败恢复与有界回退扩大
- 十万 token 文档的局部更新性能与身份保留
- 随机模糊（多轮随机编辑后增量结果恒等于全量分词）
