import type { FindingCategory, ConfidenceLevel, Severity } from '../../src/core/model/findings.ts';

/** A file tree, as repo-relative path -> contents. */
export type Tree = Readonly<Record<string, string>>;

export interface ExpectedFinding {
  readonly category: FindingCategory;
  readonly minSeverity?: Severity;
  readonly minConfidence?: ConfidenceLevel;
  /** Substrings that must each appear in at least one of the finding's symbol ids. */
  readonly symbolsInclude?: readonly string[];
  /** Substring that must appear in the finding's title or description. */
  readonly mentions?: string;
}

/**
 * Whether the type checker, run on the tree git would produce, reports an error.
 *
 * This is the incumbent baseline: a merge queue with `tsc --noEmit` as a
 * required check catches exactly this set for free. Recording it per fixture
 * is what lets the evaluation say where Hairline adds something and where it
 * is duplicating work a repository may already be doing.
 */
export type BaselineExpectation =
  /** `tsc` on the merged tree reports an error. Hairline should agree, earlier and with attribution. */
  | 'catches'
  /** `tsc` on the merged tree is clean. Only Hairline can see this. */
  | 'misses'
  /** `tsc` is clean and so is the merge; nothing is wrong. */
  | 'not-applicable';

export interface Fixture {
  readonly name: string;
  /** One sentence: what two agents did, and why it is or is not a problem. */
  readonly summary: string;
  /**
   * Whether Hairline should report an interaction. `false` fixtures are the
   * restraint half of the benchmark — a detector that fires on everything is
   * as useless as one that fires on nothing.
   */
  readonly conflict: boolean;
  readonly baseline: BaselineExpectation;
  /**
   * Expected to produce a textual git conflict. Most fixtures are `false`:
   * the interesting cases are the ones git merges happily.
   */
  readonly gitConflict?: boolean;
  /**
   * Set when a branch is deliberately broken on its own. Normally both
   * branches type-check in isolation — that is the premise of the whole
   * problem — and the harness asserts it.
   */
  readonly branchesSelfConsistent?: boolean;
  readonly base: Tree;
  readonly branchA: Tree;
  readonly branchB: Tree;
  readonly expect?: readonly ExpectedFinding[];
  /** Why this fixture is in the corpus, if it is not obvious. */
  readonly note?: string;
}
