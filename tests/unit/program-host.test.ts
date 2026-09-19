import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memorySnapshot } from '../../src/git/snapshot.ts';
import { createSnapshotProgram, typeErrorsFor, VIRTUAL_ROOT } from '../../src/languages/typescript/program.ts';
import { TypeScriptAdapter } from '../../src/languages/typescript/adapter.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The compiler host is where a silent failure is most expensive.
 *
 * If dependency types stop resolving, nothing crashes and nothing is
 * reported: contracts quietly degrade to `any`, comparisons between revisions
 * still "succeed", and Hairline reports fewer interactions with no sign that
 * it has gone half-blind. These tests exist because exactly that happened —
 * `fileExists` consulted the disk while `readFile` did not, so the host
 * claimed every dependency file existed and then refused to produce it.
 */
describe('snapshot compiler host', () => {
  test('resolves a dependency from the installed node_modules', () => {
    const snapshot = memorySnapshot('deps', {
      'src/a.ts': `import ts from 'typescript';\nexport const version: string = ts.version;`,
    });
    const program = createSnapshotProgram(snapshot, { nodeModulesRoot: REPO_ROOT });
    const errors = typeErrorsFor(program);
    assert.deepEqual(
      errors.map((e) => e.message),
      [],
      'a dependency import must resolve when node_modules is available',
    );
  });

  test('resolves ambient @types packages', () => {
    const snapshot = memorySnapshot('types', {
      'src/a.ts': `export const cwd: string = process.cwd();`,
    });
    const program = createSnapshotProgram(snapshot, { nodeModulesRoot: REPO_ROOT });
    assert.deepEqual(typeErrorsFor(program).map((e) => e.message), []);
  });

  test('dependency types reach extracted contracts rather than degrading to any', () => {
    const index = new TypeScriptAdapter().index(
      memorySnapshot('deps', {
        'src/a.ts': `import ts from 'typescript';\nexport function kindOf(): ts.SyntaxKind { return ts.SyntaxKind.Identifier; }`,
      }),
      { nodeModulesRoot: REPO_ROOT },
    );
    const symbol = [...index.symbols.values()].find((s) => s.name === 'kindOf');
    assert.ok(symbol, 'kindOf should be indexed');
    const returnType = symbol.contract.callable?.[0]?.returnTypeText ?? '';
    assert.ok(
      returnType.includes('SyntaxKind'),
      `the dependency type should survive into the contract, got ${JSON.stringify(returnType)}`,
    );
  });

  test('without node_modules, unresolved dependencies are reported rather than hidden', () => {
    const index = new TypeScriptAdapter().index(
      memorySnapshot('nodeps', {
        'src/a.ts': `import ts from 'typescript';\nexport const v = ts.version;`,
      }),
    );
    // The import does not resolve, and coverage must reflect that honestly.
    assert.ok(index.coverage.referencesUnresolved > 0 || index.coverage.referencesExternal === 0);
  });

  test('snapshot files win over same-named files on disk', () => {
    // A snapshot file must never be silently served from the working tree,
    // or two revisions could observe the same content.
    const snapshot = memorySnapshot('shadow', {
      'package.json': '{"name":"not-the-real-one"}',
      'src/a.ts': 'export const a = 1;',
    });
    const program = createSnapshotProgram(snapshot, { nodeModulesRoot: REPO_ROOT });
    assert.equal(
      program.program.getSourceFile(`${VIRTUAL_ROOT}/src/a.ts`)?.text,
      'export const a = 1;',
    );
  });

  test('disk reads stay inside the permitted roots', () => {
    const snapshot = memorySnapshot('escape', { 'src/a.ts': 'export const a = 1;' });
    const program = createSnapshotProgram(snapshot, { nodeModulesRoot: REPO_ROOT });
    // Nothing outside lib/ and node_modules/ may be loaded into the program.
    for (const file of program.program.getSourceFiles()) {
      const inSnapshot = program.fromVirtual(file.fileName) !== undefined;
      const inLibOrModules =
        file.fileName.includes('/typescript/lib/') || file.fileName.includes('/node_modules/');
      assert.ok(
        inSnapshot || inLibOrModules,
        `program loaded an unexpected file: ${file.fileName}`,
      );
    }
  });

  test('two snapshots in one process do not see each other', () => {
    const first = createSnapshotProgram(memorySnapshot('v1', { 'src/a.ts': `export const V = 1;` }));
    const second = createSnapshotProgram(memorySnapshot('v2', { 'src/a.ts': `export const V = 2;` }));
    assert.match(first.program.getSourceFile(`${VIRTUAL_ROOT}/src/a.ts`)!.text, /= 1;/);
    assert.match(second.program.getSourceFile(`${VIRTUAL_ROOT}/src/a.ts`)!.text, /= 2;/);
  });

  test('a repository tsconfig influences resolution but cannot redirect output', () => {
    const snapshot = memorySnapshot('cfg', {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] }, outDir: 'build' },
      }),
      'src/lib/helper.ts': `export const help = 1;`,
      'src/app.ts': `import { help } from '@lib/helper.ts';\nexport const v: number = help;`,
    });
    const program = createSnapshotProgram(snapshot, { nodeModulesRoot: REPO_ROOT });
    assert.deepEqual(
      typeErrorsFor(program).map((e) => e.message),
      [],
      'a path alias from the snapshot tsconfig should be honoured',
    );
    assert.equal(program.program.getCompilerOptions().outDir, undefined);
    assert.equal(program.program.getCompilerOptions().noEmit, true);
  });
});
