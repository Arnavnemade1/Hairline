import type { SemanticIndex } from '../model/snapshot.ts';
import type { AnalysisDiagnostic, Coverage } from '../model/diagnostics.ts';
import { resolutionRate } from '../model/diagnostics.ts';
import { compareFindings, type Finding } from '../model/findings.ts';
import type { ModulePath } from '../model/ids.ts';
import { SemanticGraph } from '../graph/semantic-graph.ts';
import { diffIndexes } from '../changes/differ.ts';
import { BranchView, type Analyzer, type PairContext } from './context.ts';
import { removedDefinitionAnalyzer, signatureAnalyzer, memberAnalyzer } from './analyzers/definition-use.ts';
import { literalSetAnalyzer } from './analyzers/literal-set.ts';
import { sameSymbolAnalyzer } from './analyzers/same-symbol.ts';
import { behavioralRiskAnalyzer } from './analyzers/behavioral.ts';

/**
 * Joins the parts of a composite key. A control character is used because it
 * cannot occur in a symbol id, a branch name, or a rendered type, so two
 * different keys can never collide by concatenation.
 */
const FIELD_SEPARATOR = String.fromCharCode(1);


/** Registered in the order their findings should be preferred when they overlap. */
export const DEFAULT_ANALYZERS: readonly Analyzer[] = [
  removedDefinitionAnalyzer,
  literalSetAnalyzer,
  signatureAnalyzer,
  memberAnalyzer,
  sameSymbolAnalyzer,
  behavioralRiskAnalyzer,
];

export interface BranchInput {
  readonly label: string;
  readonly index: SemanticIndex;
}

export interface EngineOptions {
  readonly analyzers?: readonly Analyzer[];
  /**
   * Findings below this confidence are computed but not returned. Low-confidence
   * rules exist so they can be measured; they are off by default so the tool's
   * first impression is its precise half.
   */
  readonly minimumConfidence?: 'high' | 'medium' | 'low';
}

/** Which branches could interact at all, and why. */
export interface PairSummary {
  readonly branches: readonly [string, string];
  readonly analysed: boolean;
  /** Symbols both branches touched, or that one changed and the other used. */
  readonly sharedSymbols: number;
  readonly sharedModules: readonly ModulePath[];
  readonly reason: string;
}

export interface AnalysisResult {
  readonly baseLabel: string;
  readonly branches: readonly string[];
  readonly findings: readonly Finding[];
  readonly pairs: readonly PairSummary[];
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly coverage: Readonly<Record<string, Coverage>>;
  /** Per-branch count of symbols whose contract moved. */
  readonly changedSymbols: Readonly<Record<string, number>>;
}

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * An analyzer throwing must not lose the findings other analyzers produced,
 * and must not pass unnoticed. Failures are collected and surfaced as
 * diagnostics, so a crash reads as "analysis incomplete" and never as
 * "nothing found".
 */
const analyzerFailures: AnalysisDiagnostic[] = [];

/**
 * Decide whether two branches can interact before running analyzers on them.
 *
 * With N branches there are N(N-1) ordered pairs, and most of them touch
 * completely unrelated parts of a repository. Checking for any shared symbol
 * or module first turns the quadratic factor into a cheap set intersection,
 * and — just as importantly — gives the report something honest to say about
 * the pairs it skipped, rather than silently omitting them.
 */
function summarisePair(left: BranchView, right: BranchView): PairSummary {
  const leftSymbols = new Set(left.changes.symbolChanges.keys());
  const shared = [...right.changes.symbolChanges.keys()].filter((id) => leftSymbols.has(id));

  const leftModules = new Set(left.changedModules());
  const sharedModules = right.changedModules().filter((m) => leftModules.has(m));

  // Changes can also meet through a reference even with no shared symbol: one
  // branch changes a definition, the other adds a use of it.
  let crossReferences = 0;
  for (const id of left.changes.symbolChanges.keys()) {
    crossReferences += right.freshReferencesTo(id).length;
  }
  for (const id of right.changes.symbolChanges.keys()) {
    crossReferences += left.freshReferencesTo(id).length;
  }

  // Or through a literal value one narrowed and the other named.
  const leftValues = new Set(
    [...left.changes.symbolChanges.values()].flatMap((c) =>
      c.deltas.filter((d) => d.kind === 'literal-removed').map((d) => d.value),
    ),
  );
  const rightValues = new Set(
    [...right.changes.symbolChanges.values()].flatMap((c) =>
      c.deltas.filter((d) => d.kind === 'literal-removed').map((d) => d.value),
    ),
  );
  const literalOverlap =
    right.freshLiterals().some((o) => leftValues.has(o.value)) ||
    left.freshLiterals().some((o) => rightValues.has(o.value));

  const analysed =
    shared.length > 0 || sharedModules.length > 0 || crossReferences > 0 || literalOverlap;

  return {
    branches: [left.label, right.label],
    analysed,
    sharedSymbols: shared.length,
    sharedModules,
    reason: analysed
      ? [
          shared.length > 0 ? `${shared.length} symbol(s) changed by both` : '',
          sharedModules.length > 0 ? `${sharedModules.length} file(s) changed by both` : '',
          crossReferences > 0 ? `${crossReferences} cross-branch reference(s)` : '',
          literalOverlap ? 'overlapping literal values' : '',
        ]
          .filter(Boolean)
          .join('; ')
      : 'no changed symbol, file, reference or value is shared between these branches',
  };
}

/**
 * Collapse findings that describe the same interaction.
 *
 * Several analyzers legitimately see the same underlying event — removing an
 * exported function is both a removed definition and, if the other branch
 * also edited it, a same-symbol conflict. The reader should be told once, by
 * whichever analyzer has the strongest evidence.
 */
export function deduplicate(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = [
      [...finding.branches].sort().join(','),
      [...finding.symbols].sort().join(','),
      finding.category,
    ].join(FIELD_SEPARATOR);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    const better =
      CONFIDENCE_RANK[finding.confidence.level] < CONFIDENCE_RANK[existing.confidence.level] ||
      (finding.confidence.level === existing.confidence.level &&
        finding.evidence.length > existing.evidence.length);
    if (better) byKey.set(key, finding);
  }

  // A high-confidence finding about a symbol makes a weaker finding about the
  // same symbol and branches redundant, even across categories.
  const kept: Finding[] = [];
  const dominant = new Set<string>();
  const ordered = [...byKey.values()].sort(compareFindings);
  for (const finding of ordered) {
    const symbolKey = `${[...finding.branches].sort().join(',')}${FIELD_SEPARATOR}${finding.symbols[0] ?? ''}`;
    if (finding.confidence.level !== 'high' && dominant.has(symbolKey)) continue;
    if (finding.confidence.level === 'high') dominant.add(symbolKey);
    kept.push(finding);
  }
  return kept;
}

/**
 * Compare several branches against one base and report how their changes meet.
 *
 * Analyzers see one ordered pair at a time: "producer changed a contract,
 * consumer depends on it". Running both orderings means an analyzer never has
 * to handle symmetry itself, at the cost of a symmetric analyzer having to
 * de-duplicate — which `sameSymbolAnalyzer` does by only acting on one
 * ordering.
 */
export function analyze(
  baseIndex: SemanticIndex,
  baseLabel: string,
  branches: readonly BranchInput[],
  options: EngineOptions = {},
): AnalysisResult {
  const analyzers = options.analyzers ?? DEFAULT_ANALYZERS;
  const minimum = options.minimumConfidence ?? 'medium';
  const baseGraph = new SemanticGraph(baseIndex);

  const views = branches.map(
    (branch) => new BranchView(diffIndexes(baseIndex, branch.index, branch.label, baseLabel), baseGraph),
  );

  const findings: Finding[] = [];
  const pairs: PairSummary[] = [];

  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const left = views[i]!;
      const right = views[j]!;
      const summary = summarisePair(left, right);
      pairs.push(summary);
      if (!summary.analysed) continue;

      for (const [producer, consumer] of [
        [left, right],
        [right, left],
      ] as const) {
        const context: PairContext = { base: baseGraph, baseLabel, producer, consumer };
        for (const analyzer of analyzers) {
          try {
            findings.push(...analyzer.analyze(context));
          } catch (error) {
            analyzerFailures.push({
              code: 'limit-exceeded',
              severity: 'error',
              message: `Analyzer \`${analyzer.id}\` failed on ${producer.label} -> ${consumer.label}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
    }
  }

  const diagnostics: AnalysisDiagnostic[] = [
    ...baseIndex.diagnostics,
    ...branches.flatMap((b) => b.index.diagnostics),
    ...analyzerFailures.splice(0),
  ];

  const coverage: Record<string, Coverage> = { [baseLabel]: baseIndex.coverage };
  for (const branch of branches) coverage[branch.label] = branch.index.coverage;

  for (const [label, entry] of Object.entries(coverage)) {
    if (resolutionRate(entry) < 0.7) {
      diagnostics.push({
        code: 'unresolved-reference',
        severity: 'warning',
        message: `Only ${Math.round(resolutionRate(entry) * 100)}% of references resolved on ${label}; interaction detection is correspondingly incomplete`,
      });
    }
  }

  const changedSymbols: Record<string, number> = {};
  for (const view of views) changedSymbols[view.label] = view.contractChanges().size;

  const filtered = deduplicate(findings).filter(
    (f) => CONFIDENCE_RANK[f.confidence.level] <= CONFIDENCE_RANK[minimum],
  );

  return {
    baseLabel,
    branches: branches.map((b) => b.label),
    findings: filtered.sort(compareFindings),
    pairs,
    diagnostics,
    coverage,
    changedSymbols,
  };
}


