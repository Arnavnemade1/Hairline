import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot } from '../../src/git/snapshot.ts';
import { TypeScriptAdapter } from '../../src/languages/typescript/adapter.ts';
import { diffIndexes } from '../../src/core/changes/differ.ts';
import { makeSymbolId, type SymbolId } from '../../src/core/model/ids.ts';
import type { ContractDeltaKind } from '../../src/core/changes/model.ts';

const adapter = new TypeScriptAdapter();

function changeSet(base: Record<string, string>, head: Record<string, string>) {
  return diffIndexes(
    adapter.index(memorySnapshot('base', base)),
    adapter.index(memorySnapshot('head', head)),
    'branch',
    'base',
  );
}

const sym = (module: string, path: string[], kind: Parameters<typeof makeSymbolId>[0]['kind']): SymbolId =>
  makeSymbolId({ language: 'ts', module, path, kind });

const deltaKinds = (
  set: ReturnType<typeof changeSet>,
  id: SymbolId,
): ContractDeltaKind[] => (set.symbolChanges.get(id)?.deltas ?? []).map((d) => d.kind);

describe('semantic change detection', () => {
  test('reformatting produces no semantic change at all', () => {
    const base = {
      'src/a.ts': `export function add(a: number, b: number): number { return a + b; }`,
    };
    const head = {
      'src/a.ts': `/**
 * Adds two numbers.
 * Added a doc comment and reformatted everything.
 */
export function add(
  a: number,
  b: number,
): number {
  // a comment that did not exist before
  return (
    a +
    b
  );
}
`,
    };
    const set = changeSet(base, head);
    assert.equal(
      set.symbolChanges.size,
      0,
      `expected no changes, got: ${[...set.symbolChanges.keys()].join(', ')}`,
    );
  });

  test('a changed body is recorded, but marked as contract-stable', () => {
    const base = { 'src/a.ts': `export function f(x: number): number { return x * 2; }` };
    const head = { 'src/a.ts': `export function f(x: number): number { return x * 3; }` };
    const set = changeSet(base, head);
    const id = sym('src/a.ts', ['f'], 'function');
    assert.deepEqual(deltaKinds(set, id), ['body-changed']);
    assert.equal(set.symbolChanges.get(id)?.contractStable, true);
  });

  test('removing a union member is a literal-removed delta', () => {
    const base = { 'src/s.ts': `export type S = 'a' | 'b' | 'c';` };
    const head = { 'src/s.ts': `export type S = 'a' | 'b';` };
    const set = changeSet(base, head);
    const change = set.symbolChanges.get(sym('src/s.ts', ['S'], 'type-alias'));
    assert.deepEqual(change?.deltas, [{ kind: 'literal-removed', value: '"c"' }]);
  });

  test('adding a required parameter changes arity, not just the parameter list', () => {
    const base = { 'src/a.ts': `export function f(a: string): void {}` };
    const head = { 'src/a.ts': `export function f(a: string, b: number): void {}` };
    const kinds = deltaKinds(changeSet(base, head), sym('src/a.ts', ['f'], 'function'));
    assert.ok(kinds.includes('parameter-added'));
    assert.ok(kinds.includes('required-arity-changed'));
  });

  test('an added optional parameter does not change required arity', () => {
    const base = { 'src/a.ts': `export function f(a: string): void {}` };
    const head = { 'src/a.ts': `export function f(a: string, b?: number): void {}` };
    const kinds = deltaKinds(changeSet(base, head), sym('src/a.ts', ['f'], 'function'));
    assert.ok(kinds.includes('parameter-added'));
    assert.ok(!kinds.includes('required-arity-changed'));
  });

  test('losing a nullable return is reported as a nullability change', () => {
    const base = {
      'src/a.ts': `export interface U { id: string }
export function get(id: string): U | null { return id ? { id } : null; }`,
    };
    const head = {
      'src/a.ts': `export interface U { id: string }
export function get(id: string): U { return { id }; }`,
    };
    const set = changeSet(base, head);
    const change = set.symbolChanges.get(sym('src/a.ts', ['get'], 'function'));
    const nullability = change?.deltas.find((d) => d.kind === 'nullability-changed');
    assert.ok(nullability, 'expected a nullability-changed delta');
    assert.equal(nullability.kind === 'nullability-changed' && nullability.nowNullable, false);
  });

  test('a renamed interface member is paired, not reported as remove plus add', () => {
    const base = { 'src/a.ts': `export interface U { id: string; name: string; }` };
    const head = { 'src/a.ts': `export interface U { id: string; fullName: string; }` };
    const set = changeSet(base, head);
    const deltas = set.symbolChanges.get(sym('src/a.ts', ['U'], 'interface'))?.deltas ?? [];
    const rename = deltas.find((d) => d.kind === 'member-renamed');
    assert.ok(rename, `expected member-renamed, got ${deltas.map((d) => d.kind).join(', ')}`);
    assert.equal(rename.kind === 'member-renamed' && rename.before, 'name');
    assert.equal(rename.kind === 'member-renamed' && rename.after, 'fullName');
  });

  test('two same-typed members swapped at once is too ambiguous to call a rename', () => {
    const base = { 'src/a.ts': `export interface U { a: string; b: string; }` };
    const head = { 'src/a.ts': `export interface U { c: string; d: string; }` };
    const deltas = changeSet(base, head).symbolChanges.get(sym('src/a.ts', ['U'], 'interface'))
      ?.deltas ?? [];
    assert.ok(!deltas.some((d) => d.kind === 'member-renamed'), 'must not guess a pairing');
    assert.equal(deltas.filter((d) => d.kind === 'member-removed').length, 2);
    assert.equal(deltas.filter((d) => d.kind === 'member-added').length, 2);
  });

  test('un-exporting a symbol is recorded even when nothing else changed', () => {
    const base = { 'src/a.ts': `export const x = 1;` };
    const head = { 'src/a.ts': `const x = 1;\nexport const y = x;` };
    const set = changeSet(base, head);
    const kinds = deltaKinds(set, sym('src/a.ts', ['x'], 'variable'));
    assert.ok(kinds.includes('export-removed'));
  });

  test('a removed symbol is a removal, and an added one an addition', () => {
    const base = { 'src/a.ts': `export function gone(): void {}` };
    const head = { 'src/a.ts': `export function fresh(): number { return 1; }` };
    const set = changeSet(base, head);
    assert.equal(set.symbolChanges.get(sym('src/a.ts', ['gone'], 'function'))?.kind, 'removed');
    assert.equal(set.symbolChanges.get(sym('src/a.ts', ['fresh'], 'function'))?.kind, 'added');
  });

  test('new call sites appear as added references', () => {
    const base = {
      'src/a.ts': `export function f(): void {}`,
      'src/b.ts': `export function g(): void {}`,
    };
    const head = {
      'src/a.ts': `export function f(): void {}`,
      'src/b.ts': `import { f } from './a.ts';\nexport function g(): void { f(); }`,
    };
    const set = changeSet(base, head);
    const added = set.addedReferences.filter(
      (r) => r.to === sym('src/a.ts', ['f'], 'function') && r.kind === 'call',
    );
    assert.equal(added.length, 1);
    assert.equal(added[0]?.range.module, 'src/b.ts');
  });

  test('moving a call to a different line is not a change', () => {
    const base = {
      'src/a.ts': `export function f(): void {}`,
      'src/b.ts': `import { f } from './a.ts';\nexport function g(): void { f(); }`,
    };
    const head = {
      'src/a.ts': `export function f(): void {}`,
      'src/b.ts': `import { f } from './a.ts';\n\n// pushed down\n\nexport function g(): void {\n  f();\n}`,
    };
    const set = changeSet(base, head);
    assert.deepEqual(set.addedReferences, []);
    assert.deepEqual(set.removedReferences, []);
  });
});
