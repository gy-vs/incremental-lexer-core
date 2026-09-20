# incremental-lexer-core

可配置规则的增量词法分析内核（TypeScript，Node.js 20，零运行时依赖）。
调用方先对整段文本分词，之后提交基于旧文本坐标的一批不重叠编辑，库返回新的
token 序列与受影响范围；未受影响的 token 保留对象身份，只原地平移位置。

## 特性

- **规则可配置**：最长匹配、优先级、规则顺序三级裁决；`skip` 规则（空白/注释）。
- **词法状态**：`push` / `pop` / `next` 状态转移，天然支持可跨行字符串、
  块注释、raw 块等。
- **增量更新**：编辑批次（旧坐标、不重叠、可乱序）→ 新 token 序列 +
  受影响范围。重扫向两侧扩展到稳定边界（token 边界 + 状态栈一致）才停止；
  无法重新同步时自动扩大范围（最多到文件末尾），但绝不无条件全量重算。
- **对象身份**：受影响范围之外的 token 是同一个对象；编辑点之后的 token
  仅 `start`/`end` 被原地平移。
- **失败恢复**：无法匹配的字符产出单字符 `error` token，词法分析继续前进。
- **可验证的局部性**：每次更新公开 `rescannedChars`（本次重扫字符数）。

## 安装与构建

```sh
npm install
npm run build   # tsc -> dist/
npm test        # tsc && node --test dist/test/
```

## 用法

```ts
import { IncrementalLexer } from 'incremental-lexer-core';

const lexer = new IncrementalLexer({
  rules: [
    { type: 'ws', pattern: /\s+/, skip: true },
    { type: 'keyword', pattern: /(?:if|else|var)\b/, priority: 1 }, // 优先级压过 ident
    { type: 'ident', pattern: /[A-Za-z_][A-Za-z0-9_]*/ },
    { type: 'number', pattern: /\d+(\.\d+)?/ },
    { type: 'eq', pattern: /==/ },            // 最长匹配压过 '='
    { type: 'assign', pattern: /=/ },
    { type: 'string-start', pattern: /"/, push: 'string' },
    { type: 'string-content', pattern: /[^"\\]+/, states: ['string'] }, // 可跨行
    { type: 'escape', pattern: /\\[\s\S]/, states: ['string'] },
    { type: 'string-end', pattern: /"/, states: ['string'], pop: true },
  ],
  // initialState: 'main', errorType: 'error'
});

lexer.setText('var a = "x";');

const result = lexer.applyEdits([{ start: 8, end: 9, text: 'y' }]);
result.tokens;          // 新的完整 token 序列
result.affectedRanges;  // 实际重扫的区域（新文本坐标 + 新 token 下标）
result.rescannedChars;  // 本次重扫字符数，用于验证局部性
```

### 编辑约定

- `Edit { start, end, text }` 表示把**旧文本**的 `[start, end)` 替换为 `text`。
- 一批编辑必须互不重叠；顺序任意（内部排序）。重叠或越界会抛异常，
  且不会破坏词法器状态。
- 返回的 `affectedRanges` 均以**新文本**坐标表示。

## 匹配语义

每个位置上，在当前状态激活的规则中取**最长匹配**；长度相同比 `priority`
（默认 0），再相同比规则声明顺序。能匹配空串的规则、以及同时声明多个状态
转移的规则会在构造时被拒绝。`push`/`pop`/`next` 互斥；在栈底 `pop` 是空操作。

## 增量算法

1. 按旧坐标应用整批编辑得到新文本，并为每个编辑计算累计位移 delta。
2. 每个编辑映射到可能受影响的 token 区间：起点回退到包含编辑点的 token
   开头（边界插入时再回退一个 token，因为最长匹配可能让前一个 token 生长；
   落在空白间隙则从上一 token 的 `stateAfter` 续扫，保留其身份）。区间相触
   的编辑合并为一个窗口。
3. 每个窗口从保存的状态栈重扫新文本，逐 token 前进，直到**重新同步点**：
   当前位置映射回旧坐标后恰好是某个旧 token 的起点，且状态栈与旧 token
   记录的栈引用相等（状态栈被 intern，比较是 O(1)）。重扫越过后续窗口的
   起点时将其吸收合并。
4. 无法同步时继续向前（回退扩大范围），最坏到文件末尾——例如删除了多行
   字符串的收尾引号。同步失败不会触发从头全量重算。
5. 拼接：窗口前的旧 token 原样保留，窗口间与末尾的旧 token 原地平移
   `start`/`end`（对象身份不变），窗口内是新 token。

## 测试

`npm test` 覆盖：跨 token 编辑、状态切换、多行字符串（内容编辑保持局部、
删引号触发范围扩大）、相邻/远距离批量编辑、窗口吸收、错误恢复、编辑校验，
以及 10 万 token 文档（全量约 100ms，单次中部编辑重扫仅数个字符、
毫秒级完成）；另有随机编辑模糊测试，逐轮与全量重算结果比对。
