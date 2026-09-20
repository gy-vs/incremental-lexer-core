import assert from 'node:assert/strict';
import { IncrementalLexer, Token } from '../src/index';

/**
 * A small language exercising every engine feature:
 * longest match (== vs =), priority (keyword vs ident), skip rules,
 * push/pop states with multiline strings, and a `next` state switch.
 */
export function makeLexer(): IncrementalLexer {
  return new IncrementalLexer({
    rules: [
      { type: 'ws', pattern: /\s+/, skip: true },
      { type: 'keyword', pattern: /(?:if|else|while|var)\b/, priority: 1 },
      { type: 'ident', pattern: /[A-Za-z_][A-Za-z0-9_]*/ },
      { type: 'number', pattern: /\d+(?:\.\d+)?/ },
      { type: 'string-start', pattern: /"/, push: 'string' },
      { type: 'string-content', pattern: /[^"\\]+/, states: ['string'] },
      { type: 'escape', pattern: /\\[\s\S]/, states: ['string'] },
      { type: 'string-end', pattern: /"/, states: ['string'], pop: true },
      { type: 'raw-open', pattern: /\{%/, next: 'raw' },
      { type: 'raw-content', pattern: /[^%]+/, states: ['raw'] },
      { type: 'raw-close', pattern: /%\}/, states: ['raw'], next: 'main' },
      { type: 'comment', pattern: /\/\*[\s\S]*?\*\// },
      { type: 'eq', pattern: /==/ },
      { type: 'le', pattern: /<=/ },
      { type: 'assign', pattern: /=/ },
      { type: 'lt', pattern: /</ },
      { type: 'op', pattern: /[+\-*\/]/ },
      { type: 'punct', pattern: /[();,{}]/ },
    ],
  });
}

/** Tokenize `text` from scratch with a fresh lexer. */
export function freshTokens(text: string): Token[] {
  const lx = makeLexer();
  lx.setText(text);
  return lx.getTokens().slice();
}

/** Assert the lexer's token stream equals a from-scratch tokenization. */
export function assertMatchesFreshLex(lexer: IncrementalLexer): void {
  const fresh = freshTokens(lexer.getText());
  const got = lexer.getTokens();
  assert.equal(
    got.length,
    fresh.length,
    `token count mismatch for ${JSON.stringify(lexer.getText())}`,
  );
  for (let i = 0; i < got.length; i++) {
    assert.deepEqual(
      [got[i].type, got[i].value, got[i].start, got[i].end],
      [fresh[i].type, fresh[i].value, fresh[i].start, fresh[i].end],
      `token ${i} mismatch`,
    );
  }
}

export function types(tokens: readonly Token[]): string[] {
  return tokens.map((t) => t.type);
}

export function values(tokens: readonly Token[]): string[] {
  return tokens.map((t) => t.value);
}
