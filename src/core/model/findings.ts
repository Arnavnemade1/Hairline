import type { ModulePath, SymbolId } from './ids.ts';
import type { SourceRange } from './source.ts';

export type FindingCategory =
  /** Both branches changed the same symbol's contract in incompatible ways. */
  | 'same-symbol-conflict'
  /** One branch changed a definition another branch depends on. */
  | 'definition-use-conflict'
  /** Call signature changed under a caller that was not updated to match. */
  | 'signature-conflict'
  /** A type's shape changed under code that assumes the previous shape. */
  | 'type-conflict'
  /** An export disappeared, moved, or changed kind under an importer. */
  | 'export-conflict'
  /** The set of admissible literal values changed under code that names one. */
  | 'literal-set-conflict'
  /** Changes meet through the module dependency graph rather than directly. */
  | 'dependency-conflict'
  /**
   * Both branches touched behaviour that meets at runtime, with no contract
   * change to prove incompatibility. Reported as a risk, never as a conflict.
   */
  | 'behavioral-risk';

export type Severity = 'high' | 'medium' | 'low' | 'info';

/**
 * Deliberately a three-valued level, not a probability.
 *
 * A number like `0.94` implies a calibrated model Hairline does not have.
 * The level is set by a named rule (`basis`), which is emitted with the
 * finding so a reader can judge it. `confidenceScore` in the JSON output is a
 * fixed, documented mapping of the level for consumers that need to sort —
 * it is not an estimated probability. See docs/evaluation.md.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export const CONFIDENCE_SCORES: Readonly<Record<ConfidenceLevel, number>> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

export interface Confidence {
  readonly level: ConfidenceLevel;
  /** Stable id of the rule that set the level, e.g. `removed-symbol-still-referenced`. */
  readonly basis: string;
  /** One sentence saying what the level is grounded in, and what it is not. */
  readonly rationale: string;
}

export type EvidenceKind =
  | 'symbol-added'
  | 'symbol-removed'
  | 'symbol-renamed'
  | 'signature-changed'
  | 'type-changed'
  | 'member-added'
  | 'member-removed'
  | 'member-type-changed'
  | 'literal-removed'
  | 'literal-added'
  | 'export-removed'
  | 'export-added'
  | 'body-changed'
  | 'reference-site'
  | 'literal-site'
  | 'import-site'
  | 'dependency-path';

/**
 * One checkable fact. Every finding is a claim built only out of these, and
 * the reporter shows them, so a reader never has to take a verdict on faith.
 */
export interface Evidence {
  readonly kind: EvidenceKind;
  /** Branch label the fact was observed on. */
  readonly branch: string;
  readonly summary: string;
  readonly symbol?: SymbolId;
  readonly range?: SourceRange;
  /** Prior state, when the fact is a change. */
  readonly before?: string;
  /** New state, when the fact is a change. */
  readonly after?: string;
}

export interface Finding {
  /** Deterministic id: stable across runs on the same inputs. */
  readonly id: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** Branch labels involved, sorted. Always at least two. */
  readonly branches: readonly string[];
  /** Symbols at the centre of the interaction, most relevant first. */
  readonly symbols: readonly SymbolId[];
  readonly files: readonly ModulePath[];
  /** One line. What interacts, and how. */
  readonly title: string;
  /** A few sentences. Why these changes meet. */
  readonly description: string;
  readonly evidence: readonly Evidence[];
  /** What a developer should do to confirm or refute this. */
  readonly verification: string;
  /** Id of the analyzer that produced it, for debugging and evaluation. */
  readonly analyzer: string;
}

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byConfidence =
    CONFIDENCE_SCORES[b.confidence.level] - CONFIDENCE_SCORES[a.confidence.level];
  if (byConfidence !== 0) return byConfidence;
  return a.id.localeCompare(b.id);
}
