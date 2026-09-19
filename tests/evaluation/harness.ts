import { run } from '../../src/run.ts';
import { runBaseline } from '../../src/evaluation/baseline.ts';
import type { Finding, ConfidenceLevel, Severity } from '../../src/core/model/findings.ts';
import type { ExpectedFinding, Fixture } from '../fixtures/types.ts';
import { buildFixture } from '../fixtures/build.ts';

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2 };

function matches(finding: Finding, expected: ExpectedFinding): boolean {
  if (finding.category !== expected.category) return false;
  if (expected.minSeverity && SEVERITY_RANK[finding.severity] > SEVERITY_RANK[expected.minSeverity]) {
    return false;
  }
  if (
    expected.minConfidence &&
    CONFIDENCE_RANK[finding.confidence.level] > CONFIDENCE_RANK[expected.minConfidence]
  ) {
    return false;
  }
  if (expected.symbolsInclude) {
    for (const needle of expected.symbolsInclude) {
      if (!finding.symbols.some((s) => s.includes(needle))) return false;
    }
  }
  if (expected.mentions) {
    const haystack = `${finding.title} ${finding.description} ${finding.evidence.map((e) => e.summary).join(' ')}`;
    if (!haystack.includes(expected.mentions)) return false;
  }
  return true;
}

export interface FixtureOutcome {
  readonly fixture: string;
  readonly expectedConflict: boolean;
  readonly detected: boolean;
  /** true positive / true negative / false positive / false negative */
  readonly classification: 'TP' | 'TN' | 'FP' | 'FN';
  /** Expectations that were declared but not met. */
  readonly unmet: readonly ExpectedFinding[];
  readonly findings: readonly Finding[];

  // Premise checks — these must hold or the fixture proves nothing.
  readonly branchesSelfConsistent: boolean;
  readonly gitClean: boolean;
  readonly premiseFailures: readonly string[];

  // Baseline comparison.
  readonly baselineExpectation: Fixture['baseline'];
  readonly baselineDetected: boolean;
  readonly baselineAgreedWithExpectation: boolean;

  readonly hairlineMs: number;
  readonly baselineMs: number;
}

export interface EvaluationReport {
  readonly outcomes: readonly FixtureOutcome[];
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  readonly unmetExpectations: number;
  readonly premiseFailures: number;
  /** Conflicts only Hairline found, i.e. the merged-tree type check was clean. */
  readonly beyondBaseline: readonly string[];
  /** Conflicts the baseline found too. */
  readonly sharedWithBaseline: readonly string[];
  readonly totalHairlineMs: number;
  readonly totalBaselineMs: number;
}

/**
 * Run one fixture through both Hairline and the incumbent baseline.
 *
 * Lives under `tests/` rather than `src/` because it depends on the fixture
 * corpus. `src/evaluation/baseline.ts` is the part that is genuinely product
 * — running the incumbent check against a repository is useful on its own —
 * and it has no knowledge of fixtures.
 *
 * The premise checks come first and are treated as failures of the *fixture*,
 * not of the tool. A fixture whose branches do not each type-check on their
 * own, or that git refuses to merge, is not an example of the problem Hairline
 * claims to solve, and counting a detection on it would be scoring a goal
 * against an empty net.
 */
export async function evaluateFixture(fixture: Fixture): Promise<FixtureOutcome> {
  const built = buildFixture(fixture);
  try {
    const baseline = await runBaseline(built.repositoryPath, built.branchA, built.branchB);

    const premiseFailures: string[] = [];
    const selfConsistent = Object.values(baseline.branchErrors).every((e) => e.length === 0);
    if (!selfConsistent && fixture.branchesSelfConsistent !== false) {
      for (const [label, errors] of Object.entries(baseline.branchErrors)) {
        if (errors.length === 0) continue;
        premiseFailures.push(
          `${label} does not type-check on its own (${errors.length} error(s), first: ${errors[0]?.message}); ` +
            `the fixture is not a cross-branch interaction`,
        );
      }
    }
    const expectGitConflict = fixture.gitConflict === true;
    if (baseline.gitClean === expectGitConflict) {
      premiseFailures.push(
        expectGitConflict
          ? 'expected a textual git conflict, but the merge was clean'
          : 'expected a clean git merge, but git reported a textual conflict',
      );
    }

    const started = performance.now();
    const result = await run({
      repositoryPath: built.repositoryPath,
      base: built.base,
      branches: [built.branchA, built.branchB],
      // Low-confidence rules are measured, not hidden: a rule that only ever
      // produces false positives should show up in the numbers.
      minimumConfidence: 'low',
    });
    const hairlineMs = Math.round(performance.now() - started);

    const detected = result.findings.length > 0;
    const unmet = (fixture.expect ?? []).filter(
      (expected) => !result.findings.some((finding) => matches(finding, expected)),
    );

    const classification: FixtureOutcome['classification'] = fixture.conflict
      ? detected
        ? 'TP'
        : 'FN'
      : detected
        ? 'FP'
        : 'TN';

    const baselineDetected = baseline.mergedErrors.length > 0;
    const baselineAgreed =
      fixture.baseline === 'catches'
        ? baselineDetected
        : fixture.baseline === 'misses'
          ? !baselineDetected
          : !baselineDetected;

    return {
      fixture: fixture.name,
      expectedConflict: fixture.conflict,
      detected,
      classification,
      unmet,
      findings: result.findings,
      branchesSelfConsistent: selfConsistent,
      gitClean: baseline.gitClean,
      premiseFailures,
      baselineExpectation: fixture.baseline,
      baselineDetected,
      baselineAgreedWithExpectation: baselineAgreed,
      hairlineMs,
      baselineMs: baseline.elapsedMs,
    };
  } finally {
    built.cleanup();
  }
}

export async function evaluate(fixtures: readonly Fixture[]): Promise<EvaluationReport> {
  const outcomes: FixtureOutcome[] = [];
  for (const fixture of fixtures) outcomes.push(await evaluateFixture(fixture));

  const truePositives = outcomes.filter((o) => o.classification === 'TP').length;
  const falsePositives = outcomes.filter((o) => o.classification === 'FP').length;
  const trueNegatives = outcomes.filter((o) => o.classification === 'TN').length;
  const falseNegatives = outcomes.filter((o) => o.classification === 'FN').length;

  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    outcomes,
    precision,
    recall,
    f1,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    unmetExpectations: outcomes.reduce((sum, o) => sum + o.unmet.length, 0),
    premiseFailures: outcomes.filter((o) => o.premiseFailures.length > 0).length,
    beyondBaseline: outcomes
      .filter((o) => o.classification === 'TP' && !o.baselineDetected)
      .map((o) => o.fixture),
    sharedWithBaseline: outcomes
      .filter((o) => o.classification === 'TP' && o.baselineDetected)
      .map((o) => o.fixture),
    totalHairlineMs: outcomes.reduce((sum, o) => sum + o.hairlineMs, 0),
    totalBaselineMs: outcomes.reduce((sum, o) => sum + o.baselineMs, 0),
  };
}
