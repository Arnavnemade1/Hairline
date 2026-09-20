import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitRepository } from '../../src/git/repository.ts';
import { buildSnapshot, DEFAULT_POLICY } from '../../src/git/snapshot.ts';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t.t',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
}

function scratchRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hairline-git-'));
  git(root, ['init', '--quiet', '--initial-branch', 'main', '.']);
  git(root, ['config', 'user.email', 't@t.t']);
  git(root, ['config', 'user.name', 'T']);
  return root;
}

/**
 * The git layer is where Hairline meets repositories it did not create, and
 * where the most surprising shapes turn up: symlinks, submodules, partial
 * clones, files that are too big, content that is not text.
 */
describe('reading trees safely', () => {
  test('symlinks are not followed', async () => {
    const root = scratchRepo();
    try {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src/real.ts'), 'export const a = 1;\n');
      // A symlink pointing outside the repository entirely.
      symlinkSync('/etc/passwd', path.join(root, 'src/leak.ts'));
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'with a symlink']);

      const repo = await GitRepository.open(root);
      const entries = await repo.listTree('main');
      const paths = entries.map((e) => e.path);
      assert.ok(paths.includes('src/real.ts'), 'the real file should be listed');
      assert.ok(
        !paths.includes('src/leak.ts'),
        'a symlink must never be listed as a readable source file',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a file over the size cap is skipped with a diagnostic, not silently', async () => {
    const root = scratchRepo();
    try {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src/small.ts'), 'export const a = 1;\n');
      writeFileSync(path.join(root, 'src/huge.ts'), `export const big = "${'x'.repeat(5000)}";\n`);
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'big file']);

      const repo = await GitRepository.open(root);
      const { snapshot, diagnostics } = await buildSnapshot(repo, 'main', 'main', {
        ...DEFAULT_POLICY,
        maxFileBytes: 1000,
      });

      assert.deepEqual(snapshot.files.map((f) => f.path), ['src/small.ts']);
      const skipped = diagnostics.filter((d) => d.code === 'file-skipped');
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0]?.module, 'src/huge.ts');
      assert.match(skipped[0]?.message ?? '', /byte limit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('binary content is recognised and skipped', async () => {
    const root = scratchRepo();
    try {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src/ok.ts'), 'export const a = 1;\n');
      // A ".ts" file that is actually binary.
      writeFileSync(path.join(root, 'src/blob.ts'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'binary']);

      const repo = await GitRepository.open(root);
      const { snapshot, diagnostics } = await buildSnapshot(repo, 'main', 'main');
      assert.deepEqual(snapshot.files.map((f) => f.path), ['src/ok.ts']);
      assert.ok(diagnostics.some((d) => d.code === 'file-skipped' && /NUL/.test(d.message)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A partial clone (`git clone --filter=blob:none`) has no blobs until they are
 * fetched, so asking `ls-tree` for sizes forces a network round trip that is
 * slow at best and fails outright offline. CI uses partial clones routinely,
 * so Hairline has to work in one.
 */
describe('partial clones', () => {
  test('a tree listing still works when blob sizes are unavailable', async () => {
    const source = scratchRepo();
    let clone: string | undefined;
    try {
      mkdirSync(path.join(source, 'src'));
      writeFileSync(path.join(source, 'src/a.ts'), 'export const a = 1;\n');
      writeFileSync(path.join(source, 'src/b.ts'), 'export const b = 2;\n');
      git(source, ['add', '--all']);
      git(source, ['commit', '--quiet', '-m', 'base']);
      // Promisor remotes require this on the serving side.
      git(source, ['config', 'uploadpack.allowFilter', 'true']);

      clone = mkdtempSync(path.join(tmpdir(), 'hairline-partial-'));
      rmSync(clone, { recursive: true, force: true });
      execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-local', source, clone], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: ENV,
      });

      const repo = await GitRepository.open(clone);
      const entries = await repo.listTree('HEAD');
      const paths = entries.map((e) => e.path).sort();
      assert.deepEqual(paths, ['src/a.ts', 'src/b.ts']);

      // And the snapshot must still produce readable content.
      const { snapshot } = await buildSnapshot(repo, 'HEAD', 'HEAD');
      assert.equal(snapshot.read('src/a.ts'), 'export const a = 1;\n');
    } finally {
      rmSync(source, { recursive: true, force: true });
      if (clone) rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe('merge-tree behaviour', () => {
  test('reports a clean merge and gives back a tree to index', async () => {
    const root = scratchRepo();
    try {
      writeFileSync(path.join(root, 'f.txt'), Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'));
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'base']);

      git(root, ['checkout', '--quiet', '-b', 'a']);
      writeFileSync(path.join(root, 'f.txt'), ['A0', ...Array.from({ length: 19 }, (_, i) => `l${i + 1}`)].join('\n'));
      git(root, ['commit', '--quiet', '-am', 'a']);

      git(root, ['checkout', '--quiet', 'main']);
      git(root, ['checkout', '--quiet', '-b', 'b']);
      writeFileSync(
        path.join(root, 'f.txt'),
        [...Array.from({ length: 19 }, (_, i) => `l${i}`), 'B19'].join('\n'),
      );
      git(root, ['commit', '--quiet', '-am', 'b']);
      git(root, ['checkout', '--quiet', 'main']);

      const repo = await GitRepository.open(root);
      const result = await repo.mergeTree('a', 'b');
      assert.equal(result.clean, true);
      assert.ok(result.treeOid, 'a clean merge must still yield a tree');
      assert.deepEqual(result.conflictedPaths, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a conflict with the conflicting paths, and does not throw', async () => {
    const root = scratchRepo();
    try {
      writeFileSync(path.join(root, 'f.txt'), 'one\n');
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'base']);

      git(root, ['checkout', '--quiet', '-b', 'a']);
      writeFileSync(path.join(root, 'f.txt'), 'A\n');
      git(root, ['commit', '--quiet', '-am', 'a']);

      git(root, ['checkout', '--quiet', 'main']);
      git(root, ['checkout', '--quiet', '-b', 'b']);
      writeFileSync(path.join(root, 'f.txt'), 'B\n');
      git(root, ['commit', '--quiet', '-am', 'b']);
      git(root, ['checkout', '--quiet', 'main']);

      const repo = await GitRepository.open(root);
      const result = await repo.mergeTree('a', 'b');
      assert.equal(result.clean, false);
      assert.deepEqual(result.conflictedPaths, ['f.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a branch name that looks like a shell command is passed through safely', async () => {
    const root = scratchRepo();
    try {
      writeFileSync(path.join(root, 'f.txt'), 'x\n');
      git(root, ['add', '--all']);
      git(root, ['commit', '--quiet', '-m', 'base']);

      const repo = await GitRepository.open(root);
      // Never executed: git receives it as a ref name and simply fails to
      // resolve it. A shell would have run the substitution.
      const resolved = await repo.tryResolve('$(touch /tmp/hairline-pwned); rm -rf .');
      assert.equal(resolved, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
