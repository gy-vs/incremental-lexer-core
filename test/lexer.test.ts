import test from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalLexer } from '../src/index';
import { makeLexer, types, values } from './helpers';

test('longest match wins over shorter alternatives', () => {
  const lx = makeLexer();
  lx.setText('a == b <= c = d < e');
  assert.deepEqual(values(lx.getTokens()), ['a', '==', 'b', '<=', 'c', '=', 'd', '<', 'e']);
  assert.deepEqual(types(lx.getTokens()), [
    'ident', 'eq', 'ident', 'le', 'ident', 'assign', 'ident', 'lt', 'ident',
  ]);
});

test('priority breaks equal-length ties (keyword vs identifier)', () => {
  const lx = makeLexer();
  lx.setText('if ifx while while2 var varr');
  assert.deepEqual(types(lx.getTokens()), [
    'keyword', 'ident', 'keyword', 'ident', 'keyword', 'ident',
  ]);
});

test('rule order breaks remaining ties', () => {
  const lx = new IncrementalLexer({
    rules: [
      { type: 'first', pattern: /ab/ },
      { type: 'second', pattern: /ab/ },
    ],
  });
  lx.setText('ab');
  assert.deepEqual(types(lx.getTokens()), ['first']);
});

test('skip rules advance without emitting tokens', () => {
  const lx = makeLexer();
  lx.setText('  a   b  ');
  assert.deepEqual(values(lx.getTokens()), ['a', 'b']);
  assert.equal(lx.getTokens()[1].start, 6);
});

test('push/pop states: string contents use string-state rules', () => {
  const lx = makeLexer();
  lx.setText('x = "he*llo" + y');
  assert.deepEqual(types(lx.getTokens()), [
    'ident', 'assign', 'string-start', 'string-content', 'string-end', 'op', 'ident',
  ]);
  // `*` inside the string is content, not an operator
  assert.equal(lx.getTokens()[3].value, 'he*llo');
});

test('escapes are matched inside strings', () => {
  const lx = makeLexer();
  lx.setText('"a\\"b" c');
  assert.deepEqual(types(lx.getTokens()), [
    'string-start', 'string-content', 'escape', 'string-content', 'string-end', 'ident',
  ]);
});

test('strings span multiple lines', () => {
  const lx = makeLexer();
  lx.setText('"line1\nline2\nline3" x');
  const content = lx.getTokens()[1];
  assert.equal(content.type, 'string-content');
  assert.equal(content.value, 'line1\nline2\nline3');
  assert.deepEqual(types(lx.getTokens()), ['string-start', 'string-content', 'string-end', 'ident']);
});

test('next switches state without a stack (raw blocks)', () => {
  const lx = makeLexer();
  lx.setText('{% a + b %} c');
  assert.deepEqual(types(lx.getTokens()), [
    'raw-open', 'raw-content', 'raw-close', 'ident',
  ]);
  // `+` inside the raw block is content, not an operator
  assert.equal(lx.getTokens()[1].value, ' a + b ');
});

test('multiline comments are single tokens', () => {
  const lx = makeLexer();
  lx.setText('a /* one\ntwo */ b');
  assert.deepEqual(types(lx.getTokens()), ['ident', 'comment', 'ident']);
});

test('unmatched characters become error tokens and lexing recovers', () => {
  const lx = makeLexer();
  lx.setText('a @# b');
  assert.deepEqual(types(lx.getTokens()), ['ident', 'error', 'error', 'ident']);
  assert.equal(lx.getTokens()[1].value, '@');
  assert.equal(lx.getTokens()[2].value, '#');
});

test('unterminated string consumes to end of file', () => {
  const lx = makeLexer();
  lx.setText('x = "abc');
  assert.deepEqual(types(lx.getTokens()), ['ident', 'assign', 'string-start', 'string-content']);
});

test('rules matching the empty string are rejected', () => {
  assert.throws(
    () => new IncrementalLexer({ rules: [{ type: 'bad', pattern: /a*/ }] }),
    /empty string/,
  );
});

test('conflicting state transitions are rejected', () => {
  assert.throws(
    () =>
      new IncrementalLexer({
        rules: [{ type: 'bad', pattern: /x/, push: 'a', pop: true }],
      }),
    /mutually exclusive/,
  );
});

test('tokens carry the state stack before and after them', () => {
  const lx = makeLexer();
  lx.setText('"s"');
  const [open, content, close] = lx.getTokens();
  assert.deepEqual(open.state, ['main']);
  assert.deepEqual(content.state, ['main', 'string']);
  assert.deepEqual(close.state, ['main', 'string']);
  assert.deepEqual(close.stateAfter, ['main']);
});
