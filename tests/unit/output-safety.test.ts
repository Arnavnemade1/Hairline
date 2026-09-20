import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot } from '../../src/git/snapshot.ts';
import { TypeScriptAdapter } from '../../src/languages/typescript/adapter.ts';
import { sanitize } from '../../src/reporters/style.ts';

const adapter = new TypeScriptAdapter();
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

/**
 * Findings quote identifiers, type renderings and string literal values taken
 * from code Hairline did not write. Without neutralising them, a repository
 * could embed escape sequences that reposition the cursor, recolour output or
 * erase lines — letting the code under analysis forge or hide parts of the
 * report about itself.
 */
describe('hostile repository content cannot forge terminal output', () => {
  test('escape sequences and other control characters are stripped', () => {
    const hostile = `${ESC}[2J${ESC}[31mFAKE: no conflicts found${ESC}[0m${BEL}and${NUL}more`;
    const cleaned = sanitize(hostile);
    assert.ok(!cleaned.includes(ESC), 'escape character survived');
    assert.ok(!cleaned.includes(NUL), 'NUL survived');
    assert.ok(!cleaned.includes(BEL), 'BEL survived');
    // Readable text is kept, so the reader still sees what the code contained.
    assert.ok(cleaned.includes('FAKE: no conflicts found'));
    assert.ok(cleaned.includes('and'));
    assert.ok(cleaned.includes('more'));
  });

  test('tabs become spaces rather than vanishing', () => {
    assert.equal(sanitize('a\tb'), 'a  b');
  });

  test('ordinary finding text is untouched', () => {
    const text = 'User.status changed from "active" | "disabled" to "active"';
    assert.equal(sanitize(text), text);
  });

  test('newlines survive, so multi-line evidence still reads correctly', () => {
    assert.equal(sanitize('one\ntwo'), 'one\ntwo');
  });

  test('literal values are JSON-encoded, so they cannot carry a raw escape', () => {
    const evil = `${ESC}[2K${ESC}[32mmerged cleanly${ESC}[0m`;
    const index = adapter.index(
      memorySnapshot('evil', { 'src/a.ts': `export type S = 'ok' | ${JSON.stringify(evil)};` }),
    );
    const symbol = [...index.symbols.values()].find((s) => s.name === 'S');
    assert.ok(symbol, 'S should be indexed');
    const values = symbol.contract.literals?.values ?? [];
    assert.equal(values.length, 2);
    for (const value of values) {
      assert.ok(!value.includes(ESC), 'JSON encoding should already have escaped the control character');
    }
  });

  test('a member name carrying escapes is neutralised on the way out', () => {
    // Property names are *not* JSON-encoded anywhere in the model, so this is
    // the path where sanitising is actually load-bearing: the name flows into
    // member deltas and into rendered symbol ids.
    const evil = `${ESC}[2K${ESC}[32mmerged cleanly${ESC}[0m`;
    const index = adapter.index(
      memorySnapshot('evil', {
        'src/a.ts': `export interface I { ${JSON.stringify(evil)}: string }`,
      }),
    );
    const iface = [...index.symbols.values()].find((s) => s.name === 'I');
    assert.ok(iface, 'I should be indexed');
    const names = (iface.contract.object?.members ?? []).map((m) => m.name);
    assert.ok(
      names.some((n) => n.includes(ESC)),
      'the model keeps the real name — sanitising belongs at the output boundary, not in the model',
    );
    for (const name of names) {
      assert.ok(!sanitize(name).includes(ESC), 'a member name must not reach the report with escapes');
    }
  });

  test('an identifier-shaped module path with escapes is neutralised', () => {
    assert.ok(!sanitize(`src/${ESC}[31mevil.ts`).includes(ESC));
  });
});
