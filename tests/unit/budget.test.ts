import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot } from '../../src/git/snapshot.ts';
import { TypeScriptAdapter } from '../../src/languages/typescript/adapter.ts';
import { diffIndexes } from '../../src/core/changes/differ.ts';

const adapter = new TypeScriptAdapter();

const SOURCES: Record<string, string> = {};
for (let i = 0; i < 12; i++) {
  SOURCES[`src/m${i}.ts`] = `export interface I${i} { a: string; b: number }
export function f${i}(x: I${i}): string { return x.a; }
export type S${i} = 'a' | 'b' | 'c';
`;
}

/**
 * Rendering a type can be arbitrarily expensive — a sufficiently recursive
 * conditional type keeps the checker busy for minutes on a single declaration,
 * and real repositories contain them. Extraction therefore runs against a
 * clock, and what matters is that running out degrades honestly rather than
 * silently producing a thinner index that reads as "nothing changed".
 */
describe('contract extraction budget', () => {
  test('an exhausted budget is reported as an error, not passed over', () => {
    const index = adapter.index(memorySnapshot('t', SOURCES), { contractBudgetMs: 1 });
    const exceeded = index.diagnostics.filter((d) => d.code === 'limit-exceeded');
    assert.equal(exceeded.length, 1, 'exhausting the budget must produce exactly one diagnostic');
    assert.equal(exceeded[0]?.severity, 'error', 'it must be an error, so the run reads as incomplete');
    assert.match(exceeded[0]?.message ?? '', /identity only/);
  });

  test('symbols are still indexed when the budget runs out', () => {
    const index = adapter.index(memorySnapshot('t', SOURCES), { contractBudgetMs: 1 });
    // Identity survives even when contracts do not.
    assert.ok(index.symbols.size > 12, `expected symbols to still be indexed, got ${index.symbols.size}`);
    assert.ok([...index.symbols.values()].some((s) => s.name === 'f0'));
  });

  test('a generous budget produces full contracts and no diagnostic', () => {
    const index = adapter.index(memorySnapshot('t', SOURCES), { contractBudgetMs: 60_000 });
    assert.equal(index.diagnostics.filter((d) => d.code === 'limit-exceeded').length, 0);
    const s0 = [...index.symbols.values()].find((s) => s.name === 'S0');
    assert.deepEqual(s0?.contract.literals?.values, ['"a"', '"b"', '"c"']);
  });

  test('a degraded index does not invent changes against a full one', () => {
    // The dangerous failure would be a budget-degraded side reading as a
    // contract change. A cheap contract records `typeResolved: false`, and the
    // differ must treat that as unknown rather than as "different".
    const full = adapter.index(memorySnapshot('a', SOURCES), { contractBudgetMs: 60_000 });
    const degraded = adapter.index(memorySnapshot('b', SOURCES), { contractBudgetMs: 1 });
    const changes = diffIndexes(full, degraded, 'branch', 'base');
    const invented = [...changes.symbolChanges.values()].filter(
      (c) => c.deltas.length > 0 && !c.deltas.every((d) => d.kind === 'body-changed'),
    );
    assert.deepEqual(
      invented.map((c) => `${c.id}: ${c.deltas.map((d) => d.kind).join(',')}`),
      [],
      'a budget-degraded index must not manufacture contract deltas',
    );
  });

  test('the budget can be disabled', () => {
    const index = adapter.index(memorySnapshot('t', SOURCES), { contractBudgetMs: 0 });
    assert.equal(index.diagnostics.filter((d) => d.code === 'limit-exceeded').length, 0);
  });
});
