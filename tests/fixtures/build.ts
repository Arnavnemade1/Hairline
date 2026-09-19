import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Fixture, Tree } from './types.ts';

/**
 * Materialise a fixture as a real git repository.
 *
 * Fixtures are exercised through actual git history rather than through
 * in-memory snapshots, because a large share of what can go wrong lives in
 * the git layer: merge bases, trial merges, tree listings, blob reads. A
 * fixture that never touched git would not test the thing most likely to
 * break on a real repository.
 */

const BRANCH_A = 'agent-a';
const BRANCH_B = 'agent-b';
const BASE = 'main';

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Hairline Fixture',
      GIT_AUTHOR_EMAIL: 'fixtures@hairline.invalid',
      GIT_COMMITTER_NAME: 'Hairline Fixture',
      GIT_COMMITTER_EMAIL: 'fixtures@hairline.invalid',
      // Deterministic history: identical fixtures produce identical oids.
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
}

function writeTree(root: string, tree: Tree): void {
  for (const [relative, contents] of Object.entries(tree)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
}

/** Remove files the previous branch wrote that this one does not declare. */
function clearTree(root: string, previous: Tree, next: Tree): void {
  for (const relative of Object.keys(previous)) {
    if (relative in next) continue;
    const target = path.join(root, relative);
    if (existsSync(target)) rmSync(target);
  }
}

export interface BuiltFixture {
  readonly fixture: Fixture;
  readonly repositoryPath: string;
  readonly base: string;
  readonly branchA: string;
  readonly branchB: string;
  cleanup(): void;
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      allowJs: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
    },
    include: ['src'],
  },
  null,
  2,
);

export function buildFixture(fixture: Fixture, into?: string): BuiltFixture {
  const root = into ?? mkdtempSync(path.join(tmpdir(), `hairline-${fixture.name}-`));
  mkdirSync(root, { recursive: true });

  git(root, ['init', '--quiet', '--initial-branch', BASE, '.']);
  git(root, ['config', 'user.email', 'fixtures@hairline.invalid']);
  git(root, ['config', 'user.name', 'Hairline Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(path.join(root, 'tsconfig.json'), TSCONFIG, 'utf8');
  writeTree(root, fixture.base);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'base']);

  git(root, ['checkout', '--quiet', '-b', BRANCH_A]);
  clearTree(root, fixture.base, fixture.branchA);
  writeTree(root, fixture.branchA);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', `${BRANCH_A}: ${fixture.summary}`]);

  git(root, ['checkout', '--quiet', BASE]);
  git(root, ['checkout', '--quiet', '-b', BRANCH_B]);
  clearTree(root, fixture.base, fixture.branchB);
  writeTree(root, fixture.branchB);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', `${BRANCH_B}: ${fixture.summary}`]);

  git(root, ['checkout', '--quiet', BASE]);

  return {
    fixture,
    repositoryPath: root,
    base: BASE,
    branchA: BRANCH_A,
    branchB: BRANCH_B,
    cleanup: () => {
      if (into === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}
