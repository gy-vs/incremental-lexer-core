import test from 'node:test';
import assert from 'node:assert/strict';
import { Edit } from '../src/index';
import { assertMatchesFreshLex, makeLexer } from './helpers';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'var ', 'foo', 'bar', 'x1', ' = ', ' == ', ' < ', ' + ', ';', '\n', '  ',
  '"str"', '"multi\nline"', '"esc\\"q"', '/* c\nc */', '{% raw %}', 'if ', 'while ',
  '123', '4.5', '(', ')', '@', // '@' produces error tokens on purpose
];

function randomText(rand: () => number, fragments: number): string {
  const parts: string[] = [];
  for (let i = 0; i < fragments; i++) {
    parts.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
  }
  return parts.join('');
}

function randomEdit(rand: () => number, textLength: number): Edit {
  const start = Math.floor(rand() * (textLength + 1));
  const end = start + Math.floor(rand() * (textLength - start + 1));
  return { start, end, text: randomText(rand, Math.floor(rand() * 4)) };
}

test('fuzz: random edit batches always match a fresh lex', () => {
  for (const seed of [1, 7, 42, 1337, 20260920]) {
    const rand = mulberry32(seed);
    const lx = makeLexer();
    lx.setText(randomText(rand, 60));
    assertMatchesFreshLex(lx);
    for (let round = 0; round < 40; round++) {
      const text = lx.getText();
      const batch: Edit[] = [];
      const count = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < count; i++) batch.push(randomEdit(rand, text.length));
      try {
        lx.applyEdits(batch);
      } catch (err) {
        // overlapping random edits are rejected; state must stay consistent
        assert.match(String(err), /Overlapping|Invalid edit/);
      }
      assertMatchesFreshLex(lx);
    }
  }
});
