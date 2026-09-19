import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../fixtures/build.ts';
import { fixtureByName } from '../fixtures/corpus.ts';
import { parseArgs, flagValue, flagValues, flagEnabled } from '../../src/cli/args.ts';
import { REPORT_SCHEMA_VERSION } from '../../src/reporters/json.ts';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'src/cli/main.ts');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function hairline(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', CLI, ...args],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('argument parsing', () => {
  test('collects repeated --branch flags', () => {
    const args = parseArgs(['analyze', '--base', 'main', '--branch', 'a', '--branch', 'b']);
    assert.equal(args.command, 'analyze');
    assert.equal(flagValue(args, 'base'), 'main');
    assert.deepEqual(flagValues(args, 'branch'), ['a', 'b']);
  });

  test('accepts --flag=value form', () => {
    const args = parseArgs(['analyze', '--base=develop']);
    assert.equal(flagValue(args, 'base'), 'develop');
  });

  test('treats known boolean flags as switches', () => {
    const args = parseArgs(['analyze', '--json', '--base', 'main']);
    assert.equal(flagEnabled(args, 'json'), true);
    assert.equal(flagValue(args, 'base'), 'main');
  });

  test('rejects a value flag with no value instead of swallowing the next flag', () => {
    assert.throws(() => parseArgs(['analyze', '--base', '--json']), /needs a value/);
  });

  test('everything after -- is positional, even if it looks like a flag', () => {
    const args = parseArgs(['analyze', '--', '--weird-branch-name']);
    assert.deepEqual(args.positional, ['--weird-branch-name']);
  });
});

describe('cli behaviour', () => {
  test('--version prints the version and exits 0', async () => {
    const result = await hairline(['--version']);
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('no arguments prints usage and exits 2', async () => {
    const result = await hairline([]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /USAGE/);
  });

  test('an unknown command exits 2 and says so', async () => {
    const result = await hairline(['frobnicate']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown command/);
  });

  test('fewer than two branches is a usage error, not an empty result', async () => {
    const result = await hairline(['analyze', '--base', 'main', '--branch', 'only-one']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /at least two branches/);
  });

  test('a bad --min-confidence is rejected', async () => {
    const result = await hairline([
      'analyze',
      '--base',
      'main',
      '--branch',
      'a',
      '--branch',
      'b',
      '--min-confidence',
      'certain',
    ]);
    assert.equal(result.code, 2);
  });

  test('analyzers lists the registered analyzers', async () => {
    const result = await hairline(['analyzers']);
    assert.equal(result.code, 0);
    for (const id of ['removed-definition', 'literal-set-change', 'signature-change', 'same-symbol']) {
      assert.match(result.stdout, new RegExp(id));
    }
  });

  test('a nonexistent revision exits 3 — analysis failed, not "nothing found"', async () => {
    const built = buildFixture(fixtureByName('export-removed-under-new-importer')!);
    try {
      const result = await hairline([
        'analyze',
        '--repo',
        built.repositoryPath,
        '--base',
        'main',
        '--branch',
        'does-not-exist',
        '--branch',
        'agent-b',
      ]);
      assert.equal(result.code, 3, `expected exit 3, got ${result.code}: ${result.stderr}`);
      assert.match(result.stderr, /could not complete/);
    } finally {
      built.cleanup();
    }
  });
});

describe('reporting on a real repository', () => {
  test('a conflicting pair exits 1 and explains itself', async () => {
    const built = buildFixture(fixtureByName('union-member-removed--widened-consumer')!);
    try {
      const result = await hairline([
        'analyze',
        '--repo',
        built.repositoryPath,
        '--base',
        'main',
        '--branches',
        'agent-a',
        'agent-b',
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stdout, /semantic integration conflict/);
      assert.match(result.stdout, /Evidence/);
      assert.match(result.stdout, /Why this confidence/);
      assert.match(result.stdout, /Suggested check/);
      assert.match(result.stdout, /git merges cleanly/);
    } finally {
      built.cleanup();
    }
  });

  test('a compatible pair exits 0 and says nothing was found', async () => {
    const built = buildFixture(fixtureByName('negative--unrelated-modules')!);
    try {
      const result = await hairline([
        'analyze',
        '--repo',
        built.repositoryPath,
        '--base',
        'main',
        '--branches',
        'agent-a',
        'agent-b',
      ]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /No likely semantic integration conflicts/);
      assert.match(result.stdout, /not analysed/);
    } finally {
      built.cleanup();
    }
  });

  test('--json emits a parseable report with a schema version', async () => {
    const built = buildFixture(fixtureByName('export-removed-under-new-importer')!);
    try {
      const result = await hairline([
        'analyze',
        '--repo',
        built.repositoryPath,
        '--base',
        'main',
        '--branches',
        'agent-a',
        'agent-b',
        '--json',
      ]);
      assert.equal(result.code, 1);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(report['schemaVersion'], REPORT_SCHEMA_VERSION);
      assert.equal((report['summary'] as { findings: number }).findings > 0, true);

      const findings = report['findings'] as Array<Record<string, unknown>>;
      const first = findings[0]!;
      assert.equal(typeof first['id'], 'string');
      assert.equal(typeof first['confidence'], 'string');
      assert.equal(typeof first['confidenceScore'], 'number');
      assert.equal(typeof first['confidenceBasis'], 'string');
      assert.ok(Array.isArray(first['evidence']));
      assert.ok((first['evidence'] as unknown[]).length > 0);

      // The report must always say how much was actually looked at.
      assert.ok(report['coverage']);
      assert.ok(report['mergeability']);
    } finally {
      built.cleanup();
    }
  });

  test('the working tree and HEAD are untouched by an analysis', async () => {
    const built = buildFixture(fixtureByName('export-removed-under-new-importer')!);
    try {
      const before = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: built.repositoryPath,
      });
      const statusBefore = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: built.repositoryPath,
      });

      await hairline([
        'analyze',
        '--repo',
        built.repositoryPath,
        '--base',
        'main',
        '--branches',
        'agent-a',
        'agent-b',
      ]);

      const after = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: built.repositoryPath,
      });
      const statusAfter = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: built.repositoryPath,
      });
      assert.equal(after.stdout, before.stdout, 'HEAD moved');
      assert.equal(statusAfter.stdout, statusBefore.stdout, 'the working tree changed');
    } finally {
      built.cleanup();
    }
  });
});
