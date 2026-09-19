import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot } from '../../src/git/snapshot.ts';
import { TypeScriptAdapter } from '../../src/languages/typescript/adapter.ts';
import { makeSymbolId, type SymbolId } from '../../src/core/model/ids.ts';
import { displayTypeText } from '../../src/core/model/contracts.ts';

const adapter = new TypeScriptAdapter();

const SOURCES = {
  'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';

export interface User {
  id: string;
  name: string;
  status: Status;
}

export function getUser(id: string): User | null {
  return id === '' ? null : { id, name: 'n', status: 'active' };
}
`,
  'src/dashboard.ts': `import { getUser, type Status } from './user.ts';

export function renderStatus(status: Status): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
    case 'disabled':
      return 'Disabled';
  }
}

export function summary(id: string): string {
  const user = getUser(id);
  return user === null ? 'none' : renderStatus(user.status);
}
`,
};

const index = adapter.index(memorySnapshot('test', SOURCES));

const id = (module: string, path: string[], kind: Parameters<typeof makeSymbolId>[0]['kind']): SymbolId =>
  makeSymbolId({ language: 'ts', module, path, kind });

describe('TypeScript indexing', () => {
  test('indexes both files with type information', () => {
    assert.equal(index.coverage.filesIndexed, 2);
    assert.equal(index.coverage.typeInformation, true);
    assert.equal(index.coverage.filesFailed, 0);
  });

  test('extracts a type alias with its literal set', () => {
    const status = index.symbols.get(id('src/user.ts', ['Status'], 'type-alias'));
    assert.ok(status, 'Status symbol should exist');
    assert.equal(status.exported, 'named');
    assert.deepEqual(status.contract.literals?.values, ['"active"', '"disabled"', '"suspended"']);
    assert.equal(status.contract.literals?.open, false);
  });

  test('extracts an interface with its members', () => {
    const user = index.symbols.get(id('src/user.ts', ['User'], 'interface'));
    assert.ok(user, 'User symbol should exist');
    const members = user.contract.object?.members.map((m) => `${m.name}: ${m.typeText}`);
    assert.deepEqual(members, [
      'id: string',
      'name: string',
      // Fully qualified on purpose: two modules may each declare a `Status`.
      'status: import("src/user").Status',
    ]);
    assert.deepEqual(user.contract.object?.members.map((m) => displayTypeText(m.typeText)), [
      'string',
      'string',
      'Status',
    ]);
  });

  test('extracts a call signature with arity', () => {
    const getUser = index.symbols.get(id('src/user.ts', ['getUser'], 'function'));
    assert.ok(getUser, 'getUser symbol should exist');
    const signature = getUser.contract.callable?.[0];
    assert.ok(signature);
    assert.equal(signature.requiredParameterCount, 1);
    assert.deepEqual(
      signature.parameters.map((p) => `${p.name}: ${p.typeText}`),
      ['id: string'],
    );
    assert.equal(displayTypeText(signature.returnTypeText), 'User | null');
  });

  test('resolves a cross-file call reference through its import alias', () => {
    const target = id('src/user.ts', ['getUser'], 'function');
    const calls = index.references.filter((r) => r.to === target && r.kind === 'call');
    assert.equal(calls.length, 1, 'exactly one call site');
    assert.equal(calls[0]?.range.module, 'src/dashboard.ts');
    assert.equal(calls[0]?.argumentCount, 1);
    // `from` is the *nearest* enclosing symbol, which here is the variable the
    // call initialises rather than the function containing it. Walking up to
    // the function is the graph's job, via parent links.
    assert.equal(calls[0]?.from, id('src/dashboard.ts', ['summary', 'user'], 'variable'));
  });

  test('records switch-case literals against the type that constrains them', () => {
    const cases = index.literals.filter((l) => l.context === 'switch-case');
    assert.equal(cases.length, 3);
    const disabled = cases.find((l) => l.value === '"disabled"');
    assert.ok(disabled, 'the "disabled" case should be observed');
    assert.equal(disabled.against, id('src/user.ts', ['Status'], 'type-alias'));
    assert.equal(disabled.enclosing, id('src/dashboard.ts', ['renderStatus'], 'function'));
    assert.equal(displayTypeText(disabled.siteTypeText ?? ''), 'Status');
  });

  test('records the import edge with a resolved target', () => {
    const edge = index.imports.find((i) => i.from === 'src/dashboard.ts');
    assert.ok(edge);
    assert.equal(edge.to, 'src/user.ts');
    assert.deepEqual([...edge.names].sort(), ['Status', 'getUser']);
  });

  test('resolves the overwhelming majority of references', () => {
    const { referencesResolved, referencesUnresolved } = index.coverage;
    const rate = referencesResolved / (referencesResolved + referencesUnresolved);
    assert.ok(rate > 0.9, `resolution rate was ${rate}`);
  });
});
