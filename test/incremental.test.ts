import test from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalLexer } from '../src/index';
import { assertMatchesFreshLex, makeLexer, types, values } from './helpers';

test('cross-token edit: deleting a space merges two identifiers', () => {
  const lx = makeLexer();
  lx.setText('var foo bar;');
  const before = lx.getTokens().slice();
  assert.deepEqual(values(before), ['var', 'foo', 'bar', ';']);

  const res = lx.applyEdits([{ start: 7, end: 8, text: '' }]);
  assert.deepEqual(values(res.tokens), ['var', 'foobar', ';']);
  assertMatchesFreshLex(lx);

  // keyword before the edit keeps identity and position
  assert.equal(res.tokens[0], before[0]);
  assert.equal(res.tokens[0].start, 0);
  // `;` after the edit keeps identity, shifted left by 1
  assert.equal(res.tokens[2], before[3]);
  assert.equal(res.tokens[2].start, 10);
  // affected range starts at the `foo` token and is reported in new coords
  assert.equal(res.affectedRanges.length, 1);
  assert.equal(res.affectedRanges[0].text.start, 4);
  assert.equal(res.rescannedChars, res.affectedRanges[0].text.end - 4);
});

test('unaffected tokens keep identity; later tokens only shift positions', () => {
  const lx = makeLexer();
  lx.setText('var a = 1; var b = 2;');
  const before = lx.getTokens().slice();
  // positions are translated in place, so snapshot the values up front
  const beforePos = before.map((t) => [t.start, t.end]);

  const res = lx.applyEdits([{ start: 8, end: 9, text: '22' }]); // 1 -> 22
  assertMatchesFreshLex(lx);

  // tokens before the edit: same object, same position
  for (const i of [0, 1, 2]) {
    assert.equal(res.tokens[i], before[i], `token ${i} identity`);
  }
  assert.equal(res.tokens[2].start, 6);
  // tokens after the edit: same object, position shifted by +1
  for (let i = 4; i < before.length; i++) {
    assert.equal(res.tokens[i], before[i], `token ${i} identity`);
    assert.equal(res.tokens[i].start, beforePos[i][0] + 1, `token ${i} start`);
    assert.equal(res.tokens[i].end, beforePos[i][1] + 1, `token ${i} end`);
  }
  assert.equal(res.rescannedChars < lx.getText().length, true);
});

test('insertion at a token boundary can merge with the previous token', () => {
  const lx = makeLexer();
  lx.setText('a<b');
  const before = lx.getTokens().slice();

  const res = lx.applyEdits([{ start: 2, end: 2, text: '=' }]); // a<=b
  assert.deepEqual(values(res.tokens), ['a', '<=', 'b']);
  assertMatchesFreshLex(lx);
  assert.equal(res.tokens[0], before[0]);
  assert.equal(res.tokens[2], before[2]);
  assert.equal(res.tokens[2].start, 3);
});

test('edit at document start uses the initial state', () => {
  const lx = makeLexer();
  lx.setText('a = 1;');
  lx.applyEdits([{ start: 0, end: 0, text: 'x' }]);
  assert.deepEqual(values(lx.getTokens()), ['xa', '=', '1', ';']);
  assertMatchesFreshLex(lx);
});

test('edit at end of input grows the last token', () => {
  const lx = makeLexer();
  lx.setText('var ab');
  const before = lx.getTokens().slice();
  const res = lx.applyEdits([{ start: 6, end: 6, text: 'c' }]);
  assert.deepEqual(values(res.tokens), ['var', 'abc']);
  assertMatchesFreshLex(lx);
  assert.equal(res.tokens[0], before[0]);
});

test('insertion into trailing whitespace restarts after the last token', () => {
  const lx = makeLexer();
  lx.setText('a;  ');
  const before = lx.getTokens().slice();
  const res = lx.applyEdits([{ start: 4, end: 4, text: 'b' }]);
  assert.deepEqual(values(res.tokens), ['a', ';', 'b']);
  assertMatchesFreshLex(lx);
  assert.equal(res.tokens[0], before[0]);
  assert.equal(res.tokens[1], before[1]);
});

test('state switch: deleting an opening quote cascades to EOF but not to 0', () => {
  const lx = makeLexer();
  lx.setText('var s = "abc"; var x = 1;');
  const before = lx.getTokens().slice();

  const res = lx.applyEdits([{ start: 8, end: 9, text: '' }]);
  assertMatchesFreshLex(lx);
  // everything from the quote on is re-lexed...
  assert.deepEqual(types(res.tokens).slice(0, 4), ['keyword', 'ident', 'assign', 'ident']);
  // ...but the prefix keeps identity and the re-scan did not start at 0
  assert.equal(res.tokens[0], before[0]);
  assert.equal(res.tokens[1], before[1]);
  assert.equal(res.tokens[2], before[2]);
  assert.equal(res.affectedRanges[0].text.start, 8);
  assert.equal(res.rescannedChars < lx.getText().length, true);
});

test('multiline string: edit inside content stays local', () => {
  const text = 'var s = "line1\nline2\nline3";\nvar after = 42;';
  const lx = makeLexer();
  lx.setText(text);
  const before = lx.getTokens().slice();
  const afterIdx = values(before).indexOf('after');
  const afterStart = before[afterIdx].start;

  const res = lx.applyEdits([{ start: 12, end: 12, text: 'X' }]);
  assertMatchesFreshLex(lx);

  const content = res.tokens[4];
  assert.equal(content.type, 'string-content');
  assert.equal(content.value, 'linXe1\nline2\nline3');
  // tokens after the string keep identity, shifted by +1
  const newAfterIdx = values(res.tokens).indexOf('after');
  assert.equal(res.tokens[newAfterIdx], before[afterIdx]);
  assert.equal(res.tokens[newAfterIdx].start, afterStart + 1);
  // locality: only the string content token was re-scanned
  assert.equal(res.rescannedChars, 18);
  assert.equal(res.rescannedChars < text.length / 2, true);
});

test('multiline string: deleting the closing quote widens the re-scan (fallback)', () => {
  const text = 'var a = "foo";\nvar b = "bar";\nvar c = 1;';
  const lx = makeLexer();
  lx.setText(text);
  const before = lx.getTokens().slice();

  const res = lx.applyEdits([{ start: 12, end: 13, text: '' }]);
  assertMatchesFreshLex(lx);
  // prefix unaffected
  assert.equal(res.tokens[0], before[0]);
  assert.equal(res.tokens[1], before[1]);
  assert.equal(res.tokens[2], before[2]);
  // re-scan widened beyond the edit but did not restart from 0
  assert.equal(res.affectedRanges[0].text.start, 9);
  assert.equal(res.rescannedChars > 10, true);
  assert.equal(res.rescannedChars < lx.getText().length, true);
});

test('raw blocks: edit inside `next`-state content stays local', () => {
  const text = '{% raw %} x {% more %} y';
  const lx = makeLexer();
  lx.setText(text);
  const before = lx.getTokens().slice();
  const yBefore = before[before.length - 1];
  const yStart = yBefore.start;

  const res = lx.applyEdits([{ start: 5, end: 5, text: 'Z' }]); // inside first raw block
  assertMatchesFreshLex(lx);
  // `y` and the second raw block keep identity
  const yAfter = res.tokens[res.tokens.length - 1];
  assert.equal(yAfter, yBefore);
  assert.equal(yAfter.start, yStart + 1);
  assert.equal(res.rescannedChars < text.length, true);
});

test('adjacent edits in one batch are merged and applied correctly', () => {
  const lx = makeLexer();
  lx.setText('var ab = 12;');
  const res = lx.applyEdits([
    { start: 4, end: 5, text: 'x' },
    { start: 5, end: 6, text: 'y' },
  ]);
  assert.deepEqual(values(res.tokens), ['var', 'xy', '=', '12', ';']);
  assertMatchesFreshLex(lx);
  assert.equal(res.affectedRanges.length, 1);
});

test('distant edits in one batch produce independent windows', () => {
  const text = 'var a = 1; var mid = 2; var z = 3;';
  const lx = makeLexer();
  lx.setText(text);
  const before = lx.getTokens().slice();
  const midIdx = values(before).indexOf('mid');
  const midStart = before[midIdx].start;
  const lastStart = before[before.length - 1].start;

  const res = lx.applyEdits([
    { start: 8, end: 9, text: '11' }, // 1 -> 11
    { start: 32, end: 33, text: '33' }, // 3 -> 33
  ]);
  assertMatchesFreshLex(lx);
  assert.equal(res.affectedRanges.length, 2);

  // tokens between the edits keep identity, shifted by the first edit's delta
  const midNewIdx = values(res.tokens).indexOf('mid');
  assert.equal(res.tokens[midNewIdx], before[midIdx]);
  assert.equal(res.tokens[midNewIdx].start, midStart + 1);
  // tokens after both edits shifted by the total delta
  const last = before.length - 1;
  assert.equal(res.tokens[res.tokens.length - 1], before[last]);
  assert.equal(res.tokens[res.tokens.length - 1].start, lastStart + 2);
  assert.equal(res.rescannedChars < 20, true);
});

test('a re-scan that cannot resync absorbs later edit windows', () => {
  // deleting the quote turns everything up to EOF into a string, swallowing
  // the region of the second edit
  const text = 'var a = "x"; var b = 1; var c = 2;';
  const lx = makeLexer();
  lx.setText(text);

  const res = lx.applyEdits([
    { start: 10, end: 11, text: '' }, // delete closing quote
    { start: 20, end: 21, text: '9' }, // 1 -> 9 (inside what becomes a string)
  ]);
  assertMatchesFreshLex(lx);
  assert.equal(res.affectedRanges.length, 1);
  assert.equal(res.affectedRanges[0].text.end, lx.getText().length);
});

test('failure recovery: error tokens are produced and can be fixed locally', () => {
  const lx = makeLexer();
  lx.setText('var a = @; var b = 2;');
  assert.deepEqual(types(lx.getTokens()).filter((t) => t === 'error'), ['error']);

  const res = lx.applyEdits([{ start: 8, end: 9, text: '1' }]);
  assert.deepEqual(values(res.tokens), ['var', 'a', '=', '1', ';', 'var', 'b', '=', '2', ';']);
  assertMatchesFreshLex(lx);
});

test('failure recovery: edits elsewhere keep error tokens identical', () => {
  const lx = makeLexer();
  lx.setText('var a = @; var b = 2;');
  const before = lx.getTokens().slice();
  const errIdx = types(before).indexOf('error');

  const res = lx.applyEdits([{ start: 19, end: 20, text: '5' }]); // 2 -> 5
  assertMatchesFreshLex(lx);
  assert.equal(res.tokens[errIdx], before[errIdx]);
  assert.equal(res.tokens[errIdx].value, '@');
});

test('sequential updates stay consistent', () => {
  const lx = makeLexer();
  lx.setText('var x = 1;');
  const edits = [
    { start: 8, end: 9, text: '42' }, // 1 -> 42
    { start: 4, end: 5, text: 'count' }, // x -> count
    { start: 10, end: 11, text: '2 + 3' }, // 42 -> 22 + 3... (text edits)
    { start: 0, end: 3, text: 'var var' }, // keyword then ident
  ];
  for (const e of edits) {
    lx.applyEdits([e]);
    assertMatchesFreshLex(lx);
  }
});

test('unsorted edit batches are accepted', () => {
  const lx = makeLexer();
  lx.setText('var a = 1; var b = 2;');
  lx.applyEdits([
    { start: 19, end: 20, text: '5' },
    { start: 8, end: 9, text: '7' },
  ]);
  assertMatchesFreshLex(lx);
  assert.deepEqual(values(lx.getTokens()).filter((v) => v === '7' || v === '5'), ['7', '5']);
});

test('overlapping and out-of-bounds edits are rejected', () => {
  const lx = makeLexer();
  lx.setText('var a = 1;');
  assert.throws(
    () => lx.applyEdits([{ start: 1, end: 4, text: '' }, { start: 3, end: 5, text: '' }]),
    /Overlapping/,
  );
  assert.throws(() => lx.applyEdits([{ start: 0, end: 100, text: '' }]), /Invalid edit/);
  assert.throws(() => lx.applyEdits([{ start: -1, end: 0, text: '' }]), /Invalid edit/);
  // failed edits must not corrupt the lexer state
  assertMatchesFreshLex(lx);
});

test('empty edit batch is a no-op', () => {
  const lx = makeLexer();
  lx.setText('var a = 1;');
  const before = lx.getTokens();
  const res = lx.applyEdits([]);
  assert.equal(res.tokens, before);
  assert.equal(res.rescannedChars, 0);
  assert.deepEqual(res.affectedRanges, []);
});

test('deleting the whole document', () => {
  const lx = makeLexer();
  lx.setText('var a = 1;');
  const res = lx.applyEdits([{ start: 0, end: 10, text: '' }]);
  assert.deepEqual(res.tokens, []);
  assert.equal(lx.getText(), '');
});

test('100k-token document: update stays local and fast', () => {
  const lines: string[] = [];
  for (let i = 0; i < 20000; i++) lines.push(`var id${i} = ${i};`);
  const text = lines.join('\n');

  const lx = makeLexer();
  const t0 = performance.now();
  lx.setText(text);
  const fullMs = performance.now() - t0;
  assert.equal(lx.getTokens().length, 100000);

  const before = lx.getTokens().slice();
  // edit the number on line 10000 (0-based), same length => delta 0
  const lineStart = lines.slice(0, 10000).join('\n').length + 1;
  const numStart = lineStart + 'var id10000 = '.length;
  const t1 = performance.now();
  const res = lx.applyEdits([{ start: numStart, end: numStart + 5, text: '99999' }]);
  const updateMs = performance.now() - t1;

  assertMatchesFreshLex(lx);
  // locality: a handful of tokens around the edit, not the document
  assert.equal(res.rescannedChars < 200, true, `rescannedChars=${res.rescannedChars}`);
  // identity at the extremes
  assert.equal(res.tokens[0], before[0]);
  assert.equal(res.tokens[res.tokens.length - 1], before[before.length - 1]);
  // delta 0: no position shifts at all
  assert.equal(res.tokens[res.tokens.length - 1].start, before[before.length - 1].start);
  t_diagnostic(`full lex 100k tokens: ${fullMs.toFixed(1)}ms, update: ${updateMs.toFixed(2)}ms, rescanned ${res.rescannedChars} chars`);
  assert.equal(updateMs < 2000, true);
});

function t_diagnostic(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`    [perf] ${msg}`);
}
