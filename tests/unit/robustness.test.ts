import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memorySnapshot, isSafeRepoPath, DEFAULT_POLICY } from '../../src/git/snapshot.ts';
import { TypeScriptAdapter } from '../../src/languages/typescript/adapter.ts';
import { analyze } from '../../src/core/analysis/engine.ts';
import { makeSymbolId, parseSymbolId } from '../../src/core/model/ids.ts';

const adapter = new TypeScriptAdapter();

/**
 * Repository content is untrusted input. These tests are about what happens
 * when it is malformed, hostile, or simply beyond what the adapter models —
 * the cases where the dangerous failure is not a crash but a *quiet* one that
 * reads as "nothing found".
 */
describe('degrading on bad input', () => {
  test('a file with a syntax error is reported, not silently dropped', () => {
    const index = adapter.index(
      memorySnapshot('broken', {
        'src/ok.ts': `export const x = 1;`,
        'src/bad.ts': `export function ( { { unterminated`,
      }),
    );
    const parseFailures = index.diagnostics.filter((d) => d.code === 'parse-failed');
    assert.ok(parseFailures.length > 0, 'a syntax error must produce a diagnostic');
    assert.equal(parseFailures[0]?.module, 'src/bad.ts');
    // The healthy file must still be indexed.
    assert.ok(index.symbols.get(makeSymbolId({ language: 'ts', module: 'src/ok.ts', path: ['x'], kind: 'variable' })));
  });

  test('an import that does not resolve is reported', () => {
    const index = adapter.index(
      memorySnapshot('dangling', {
        'src/a.ts': `import { missing } from './nowhere.ts';\nexport const y = missing;`,
      }),
    );
    assert.ok(index.diagnostics.some((d) => d.code === 'unresolved-import'));
  });

  test('a dynamic import is recorded as an untracked construct', () => {
    const index = adapter.index(
      memorySnapshot('dynamic', {
        'src/a.ts': `export async function load(): Promise<unknown> { return import('./b.ts'); }`,
        'src/b.ts': `export const b = 1;`,
      }),
    );
    assert.ok(
      index.diagnostics.some((d) => d.code === 'unsupported-construct' && d.message.includes('Dynamic import')),
      'a dynamic import must be visible as a gap, not silently ignored',
    );
    assert.ok(index.imports.some((i) => i.dynamic));
  });

  test('a declaration with a computed name is recorded rather than mis-identified', () => {
    const index = adapter.index(
      memorySnapshot('computed', {
        'src/a.ts': `const key = 'dynamic';\nexport class C { [key]() { return 1; } }`,
      }),
    );
    assert.ok(
      index.diagnostics.some((d) => d.code === 'unsupported-construct'),
      'a name Hairline cannot reason about must be declared as such',
    );
  });

  test('deeply nested syntax does not exhaust the stack', () => {
    const depth = 400;
    const source = `export const v = ${'('.repeat(depth)}1${')'.repeat(depth)};`;
    assert.doesNotThrow(() => adapter.index(memorySnapshot('deep', { 'src/a.ts': source })));
  });

  test('a file that is only comments produces no symbols and no errors', () => {
    const index = adapter.index(memorySnapshot('empty', { 'src/a.ts': `// nothing here\n` }));
    assert.equal(index.coverage.filesFailed, 0);
    assert.equal([...index.symbols.values()].filter((s) => s.kind !== 'module').length, 0);
  });

  test('an empty snapshot analyses cleanly rather than throwing', () => {
    const empty = adapter.index(memorySnapshot('none', {}));
    const result = analyze(empty, 'base', [
      { label: 'a', index: empty },
      { label: 'b', index: empty },
    ]);
    assert.deepEqual(result.findings, []);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0]?.analysed, false);
  });
});

describe('path safety', () => {
  const unsafe = [
    '../outside.ts',
    '/etc/passwd',
    'src/../../escape.ts',
    'src\\windows.ts',
    './relative.ts',
    '',
    'src//double.ts',
  ];
  for (const path of unsafe) {
    test(`rejects ${JSON.stringify(path)}`, () => {
      assert.equal(isSafeRepoPath(path), false);
    });
  }

  const safe = ['src/a.ts', 'a.ts', 'deeply/nested/path/file.tsx'];
  for (const path of safe) {
    test(`accepts ${JSON.stringify(path)}`, () => {
      assert.equal(isSafeRepoPath(path), true);
    });
  }
});

describe('resource limits', () => {
  test('the default policy excludes dependency and build directories', () => {
    for (const directory of ['node_modules/', 'dist/', '.git/']) {
      assert.ok(
        DEFAULT_POLICY.excludedDirectories.includes(directory),
        `${directory} must not be indexed`,
      );
    }
  });

  test('the default policy caps individual file size', () => {
    assert.ok(DEFAULT_POLICY.maxFileBytes > 0 && DEFAULT_POLICY.maxFileBytes <= 8 * 1024 * 1024);
  });
});

describe('symbol identity', () => {
  test('round-trips through encoding', () => {
    const parts = {
      language: 'ts' as const,
      module: 'src/user.ts',
      path: ['UserService', 'getUser'],
      kind: 'method' as const,
    };
    const parsed = parseSymbolId(makeSymbolId(parts));
    assert.deepEqual(parsed, parts);
  });

  test('round-trips names containing the separator characters', () => {
    const parts = {
      language: 'ts' as const,
      module: 'src/odd.ts',
      path: ['weird.name', 'with@at'],
      kind: 'property' as const,
    };
    const parsed = parseSymbolId(makeSymbolId(parts));
    assert.deepEqual(parsed?.path, ['weird.name', 'with@at']);
  });

  test('keeps overloads distinct', () => {
    const base = { language: 'ts' as const, module: 'src/a.ts', path: ['f'], kind: 'function' as const };
    assert.notEqual(makeSymbolId(base), makeSymbolId({ ...base, disambiguator: 1 }));
    assert.equal(parseSymbolId(makeSymbolId({ ...base, disambiguator: 2 }))?.disambiguator, 2);
  });

  test('malformed ids parse to undefined rather than throwing', () => {
    for (const bad of ['', 'nonsense', 'ts:no-hash', 'py:src/a.py#f@function']) {
      assert.equal(parseSymbolId(bad), undefined, `${JSON.stringify(bad)} should not parse`);
    }
  });

  test('different kinds of the same name are different symbols', () => {
    const shared = { language: 'ts' as const, module: 'src/a.ts', path: ['Foo'] };
    assert.notEqual(
      makeSymbolId({ ...shared, kind: 'interface' }),
      makeSymbolId({ ...shared, kind: 'function' }),
    );
  });
});

describe('honest reporting of incompleteness', () => {
  test('a low reference-resolution rate is surfaced as a warning', () => {
    // A file of nothing but unresolvable globals: every identifier dangles.
    const source = Array.from({ length: 40 }, (_, i) => `export const v${i} = UNDEFINED_GLOBAL_${i};`).join('\n');
    const index = adapter.index(memorySnapshot('dangling', { 'src/a.ts': source }));
    const result = analyze(index, 'base', [
      { label: 'a', index },
      { label: 'b', index },
    ]);
    assert.ok(
      result.diagnostics.some((d) => d.code === 'unresolved-reference' && d.severity === 'warning'),
      'when most references do not resolve, the report must say so',
    );
  });

  test('coverage counts are reported alongside findings', () => {
    const index = adapter.index(memorySnapshot('x', { 'src/a.ts': 'export const a = 1;' }));
    const result = analyze(index, 'base', [
      { label: 'a', index },
      { label: 'b', index },
    ]);
    assert.equal(result.coverage['base']?.filesIndexed, 1);
    assert.equal(result.coverage['a']?.typeInformation, true);
  });
});
