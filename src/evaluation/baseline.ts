import { GitRepository } from '../git/repository.ts';
import { buildSnapshot, buildSnapshotFromTree, DEFAULT_POLICY } from '../git/snapshot.ts';
import { createSnapshotProgram, typeErrorsFor } from '../languages/typescript/program.ts';
import type { ModulePath } from '../core/model/ids.ts';

export interface BaselineError {
  readonly module: ModulePath;
  readonly line: number;
  readonly message: string;
  readonly code: number;
}

export interface BaselineResult {
  /** Whether `git merge-tree` produced a tree at all. */
  readonly merged: boolean;
  readonly gitClean: boolean;
  readonly conflictedPaths: readonly string[];
  /** Errors on the merged tree. Empty when the baseline sees nothing wrong. */
  readonly mergedErrors: readonly BaselineError[];
  /** Errors each branch has on its own, which must be empty for a fair comparison. */
  readonly branchErrors: Readonly<Record<string, readonly BaselineError[]>>;
  readonly elapsedMs: number;
}

/**
 * The incumbent: type-check the tree a merge queue would build.
 *
 * Prior-art research identified this as the real competitor for anything
 * type-visible — a repository with `tsc --noEmit` as a required check and a
 * merge queue enabled already catches that class, for free. Measuring against
 * it is the only honest way to say where Hairline adds detection rather than
 * only attribution and timing, and it is run over the same fixtures so the
 * two numbers are directly comparable.
 *
 * It is also the fairness check on the corpus itself: if a branch has type
 * errors *on its own*, the fixture is not a cross-branch interaction at all,
 * and the harness fails it rather than counting a free win.
 */
export async function runBaseline(
  repositoryPath: string,
  branchA: string,
  branchB: string,
): Promise<BaselineResult> {
  const started = performance.now();
  const repo = await GitRepository.open(repositoryPath);

  const oidA = await repo.resolve(branchA);
  const oidB = await repo.resolve(branchB);

  const branchErrors: Record<string, readonly BaselineError[]> = {};
  for (const [label, oid] of [
    [branchA, oidA],
    [branchB, oidB],
  ] as const) {
    const build = await buildSnapshot(repo, oid, label, DEFAULT_POLICY);
    branchErrors[label] = typeErrorsFor(createSnapshotProgram(build.snapshot));
  }

  const merge = await repo.mergeTree(oidA, oidB);
  if (!merge.treeOid) {
    return {
      merged: false,
      gitClean: merge.clean,
      conflictedPaths: merge.conflictedPaths,
      mergedErrors: [],
      branchErrors,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  // Even a conflicted merge produces a tree; it just has conflict markers in
  // it. Type-checking that would report syntax noise rather than the semantic
  // question, so it is only done for clean merges.
  if (!merge.clean) {
    return {
      merged: true,
      gitClean: false,
      conflictedPaths: merge.conflictedPaths,
      mergedErrors: [],
      branchErrors,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  const mergedBuild = await buildSnapshotFromTree(repo, merge.treeOid, 'merged', DEFAULT_POLICY);
  const mergedErrors = typeErrorsFor(createSnapshotProgram(mergedBuild.snapshot));

  return {
    merged: true,
    gitClean: true,
    conflictedPaths: [],
    mergedErrors,
    branchErrors,
    elapsedMs: Math.round(performance.now() - started),
  };
}
