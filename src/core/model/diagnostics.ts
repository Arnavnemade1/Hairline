import type { ModulePath } from './ids.ts';
import type { SourceRange } from './source.ts';

/**
 * Codes are stable and machine-checkable. They exist so that "Hairline found
 * nothing" can be distinguished from "Hairline could not look" — the
 * distinction §37 of the brief insists on, and the one most likely to make a
 * tool like this quietly untrustworthy if it is lost.
 */
export type DiagnosticCode =
  /** A file could not be parsed at all. Its symbols are absent from the index. */
  | 'parse-failed'
  /** The file was parsed, but the checker produced no usable type for a symbol. */
  | 'type-unavailable'
  /** An import specifier did not resolve to a file inside the snapshot. */
  | 'unresolved-import'
  /** An identifier could not be bound to a declaration. */
  | 'unresolved-reference'
  /** The file was deliberately not indexed (size, binary, ignore rules). */
  | 'file-skipped'
  /** A language feature the adapter models imprecisely or not at all. */
  | 'unsupported-construct'
  /** The adapter hit a limit (depth, time, memory) and stopped early. */
  | 'limit-exceeded'
  /** Indexing a revision failed outright. */
  | 'snapshot-failed';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface AnalysisDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly module?: ModulePath;
  readonly range?: SourceRange;
  /** Revision this was observed at, when known. */
  readonly revision?: string;
}

/**
 * How much of the repository the analysis actually managed to see.
 *
 * Reported alongside every result. A finding count means very little without
 * it: "0 findings, 4 of 500 files indexed" is not a clean bill of health.
 */
export interface Coverage {
  readonly filesDiscovered: number;
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly filesFailed: number;
  readonly symbolsIndexed: number;
  /** Bound to a declaration inside this repository. */
  readonly referencesResolved: number;
  /**
   * Bound by the checker to a declaration outside the snapshot — the standard
   * library or an installed dependency.
   *
   * These are not gaps. `array.push(x)` resolves perfectly well; its
   * declaration simply lives in `lib.es5.d.ts`, and no branch of this
   * repository can change it. Counting them as failures would make a healthy
   * repository look 30% unanalysed and bury the references that genuinely
   * did not bind.
   */
  readonly referencesExternal: number;
  /**
   * Bound to something declared in this repository that Hairline does not
   * model — a destructured binding, a catch parameter. Locals cannot
   * participate in a cross-branch interaction, so these are tracked but do
   * not count against coverage.
   */
  readonly referencesLocal: number;
  /** Did not bind at all. The only category that is a real gap. */
  readonly referencesUnresolved: number;
  /** True when a type checker supplied types for this snapshot. */
  readonly typeInformation: boolean;
}

export function emptyCoverage(): Coverage {
  return {
    filesDiscovered: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    symbolsIndexed: 0,
    referencesResolved: 0,
    referencesExternal: 0,
    referencesLocal: 0,
    referencesUnresolved: 0,
    typeInformation: false,
  };
}

/**
 * Fraction of references *that could name something in this repository* which
 * actually did, 0..1.
 *
 * External and local references are excluded from both sides: neither is a
 * gap in Hairline's understanding, and including them would make the number
 * move for reasons that have nothing to do with analysis quality.
 */
export function resolutionRate(coverage: Coverage): number {
  const total = coverage.referencesResolved + coverage.referencesUnresolved;
  return total === 0 ? 1 : coverage.referencesResolved / total;
}
