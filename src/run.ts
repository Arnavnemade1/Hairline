import { existsSync } from 'node:fs';
import path from 'node:path';
import { GitRepository } from './git/repository.ts';
import { buildSnapshot, DEFAULT_POLICY, type SnapshotPolicy } from './git/snapshot.ts';
import { TypeScriptAdapter } from './languages/typescript/adapter.ts';
import { AdapterRegistry, type LanguageAdapter } from './languages/adapter.ts';
import { analyze, type AnalysisResult, type BranchInput, type EngineOptions } from './core/analysis/engine.ts';
import type { AnalysisDiagnostic } from './core/model/diagnostics.ts';
import type { SemanticIndex } from './core/model/snapshot.ts';

export interface RunOptions extends EngineOptions {
  readonly repositoryPath: string;
  readonly base: string;
  readonly branches: readonly string[];
  readonly policy?: SnapshotPolicy;
  /**
   * Consult the working tree's `node_modules` for dependency types.
   *
   * On by default when the directory exists, because without it every
   * `import` from a package resolves to nothing and contracts that mention a
   * library type degrade to `any`. It is an explicit, documented approximation:
   * dependencies are read from the working tree, not from the revision being
   * analysed. When a revision changes `package.json`, a diagnostic says so.
   */
  readonly useInstalledDependencies?: boolean;
}

/** Everything the CLI and the JSON reporter need. */
export interface RunResult extends AnalysisResult {
  readonly repositoryPath: string;
  readonly baseRevision: string;
  readonly branchRevisions: Readonly<Record<string, string>>;
  /** What `git merge-tree` says about merging each pair, with no commit made. */
  readonly mergeability: readonly MergeCheck[];
  readonly timings: Readonly<Record<string, number>>;
}

export interface MergeCheck {
  readonly branches: readonly [string, string];
  readonly gitClean: boolean;
  readonly conflictedPaths: readonly string[];
}

function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(new TypeScriptAdapter());
}

/**
 * Index one revision with every adapter that claims files in it.
 *
 * Today there is one adapter, so this is a single call; the shape exists
 * because "which languages are in this snapshot" is the question the engine
 * will have to answer when there are more, and answering it here keeps
 * language dispatch out of the analysis layer entirely.
 */
function indexSnapshot(
  adapter: LanguageAdapter,
  snapshot: Parameters<LanguageAdapter['index']>[0],
  nodeModulesRoot: string | undefined,
): SemanticIndex {
  return adapter.index(snapshot, nodeModulesRoot ? { nodeModulesRoot } : {});
}

/**
 * Analyse several branches of a real repository against their merge base.
 *
 * Nothing here writes to the repository: revisions are read out of the object
 * database, the working tree is never touched, and `merge-tree` performs the
 * trial merges without creating a commit or moving HEAD.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const timings: Record<string, number> = {};
  const started = performance.now();

  const repo = await GitRepository.open(options.repositoryPath);
  const policy = options.policy ?? DEFAULT_POLICY;
  const registry = defaultRegistry();
  const adapter = registry.get('ts')!;

  const branchRevisions: Record<string, string> = {};
  for (const branch of options.branches) {
    branchRevisions[branch] = await repo.resolve(branch);
  }

  // The base is the common ancestor of everything being compared, not just of
  // the first pair — otherwise each branch's change set would be measured
  // against a different origin and could not be compared.
  const explicitBase = await repo.resolve(options.base);
  const mergeBase = await repo.mergeBase([explicitBase, ...options.branches]);

  const diagnostics: AnalysisDiagnostic[] = [];
  if (mergeBase !== explicitBase) {
    diagnostics.push({
      code: 'snapshot-failed',
      severity: 'info',
      message:
        `\`${options.base}\` is not an ancestor of every branch; using their common ancestor ` +
        `${await repo.shortOid(mergeBase)} as the base instead`,
      revision: mergeBase,
    });
  }

  const nodeModulesRoot =
    (options.useInstalledDependencies ?? true) &&
    existsSync(path.join(repo.root, 'node_modules'))
      ? repo.root
      : undefined;

  const indexStart = performance.now();
  const baseBuild = await buildSnapshot(repo, mergeBase, options.base, policy);
  const baseIndex = indexSnapshot(adapter, baseBuild.snapshot, nodeModulesRoot);
  diagnostics.push(...baseBuild.diagnostics);

  const branchInputs: BranchInput[] = [];
  for (const branch of options.branches) {
    const build = await buildSnapshot(repo, branchRevisions[branch]!, branch, policy);
    diagnostics.push(...build.diagnostics);
    branchInputs.push({ label: branch, index: indexSnapshot(adapter, build.snapshot, nodeModulesRoot) });

    // Dependency types come from the working tree, so a branch that changes
    // its manifest is being analysed against the wrong dependency versions.
    if (nodeModulesRoot) {
      const basePackage = baseBuild.snapshot.read('package.json');
      const branchPackage = build.snapshot.read('package.json');
      if (basePackage !== undefined && branchPackage !== undefined && basePackage !== branchPackage) {
        diagnostics.push({
          code: 'unsupported-construct',
          severity: 'warning',
          message:
            `${branch} changes package.json, but dependency types are read from the working tree's ` +
            `node_modules. Contracts that mention dependency types may not reflect this branch.`,
          module: 'package.json',
          revision: branchRevisions[branch]!,
        });
      }
    }
  }
  timings.indexMs = Math.round(performance.now() - indexStart);

  const mergeStart = performance.now();
  const mergeability: MergeCheck[] = [];
  for (let i = 0; i < options.branches.length; i++) {
    for (let j = i + 1; j < options.branches.length; j++) {
      const a = options.branches[i]!;
      const b = options.branches[j]!;
      const result = await repo.mergeTree(branchRevisions[a]!, branchRevisions[b]!);
      mergeability.push({
        branches: [a, b],
        gitClean: result.clean,
        conflictedPaths: result.conflictedPaths,
      });
    }
  }
  timings.mergeCheckMs = Math.round(performance.now() - mergeStart);

  const analysisStart = performance.now();
  const result = analyze(baseIndex, options.base, branchInputs, options);
  timings.analysisMs = Math.round(performance.now() - analysisStart);
  timings.totalMs = Math.round(performance.now() - started);

  return {
    ...result,
    diagnostics: [...diagnostics, ...result.diagnostics],
    repositoryPath: repo.root,
    baseRevision: mergeBase,
    branchRevisions,
    mergeability,
    timings,
  };
}
