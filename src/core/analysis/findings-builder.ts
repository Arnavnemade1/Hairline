import { createHash } from 'node:crypto';
import { describeSymbolId, type ModulePath, type SymbolId } from '../model/ids.ts';
import type {
  Confidence,
  ConfidenceLevel,
  Evidence,
  Finding,
  FindingCategory,
  Severity,
} from '../model/findings.ts';

/**
 * Joins the parts of a composite key. A control character is used because it
 * cannot occur in a symbol id, a branch name, or a rendered type, so two
 * different keys can never collide by concatenation.
 */
const FIELD_SEPARATOR = String.fromCharCode(1);

export interface FindingDraft {
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly branches: readonly string[];
  readonly symbols: readonly SymbolId[];
  readonly files: readonly ModulePath[];
  readonly title: string;
  readonly description: string;
  readonly evidence: readonly Evidence[];
  readonly verification: string;
  readonly analyzer: string;
}

/**
 * Findings are identified by what they claim, not by when they were produced.
 *
 * Two runs over the same commits must produce the same ids, or nothing
 * downstream — baselines, suppressions, "is this new since yesterday?" — can
 * work. Positions are excluded from the hash for the same reason they are
 * excluded from symbol identity: they move for uninteresting reasons.
 */
export function findingId(draft: FindingDraft): string {
  const material = [
    draft.analyzer,
    draft.category,
    [...draft.branches].sort().join(','),
    [...draft.symbols].sort().join(','),
    [...draft.evidence]
      .map((e) => `${e.kind}:${e.branch}:${e.symbol ?? ''}:${e.before ?? ''}:${e.after ?? ''}`)
      .sort()
      .join('|'),
  ].join(FIELD_SEPARATOR);
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

export function buildFinding(draft: FindingDraft): Finding {
  return {
    id: findingId(draft),
    ...draft,
    branches: [...draft.branches].sort(),
    symbols: [...new Set(draft.symbols)],
    files: [...new Set(draft.files)].sort(),
  };
}

/**
 * The confidence vocabulary, in one place.
 *
 * Every level is attached to a named rule and a sentence saying what the
 * level rests on. The rules are listed in docs/evaluation.md, and the
 * evaluation harness reports precision per rule, so a rule that turns out to
 * be unreliable can be found and fixed rather than quietly diluting the whole
 * tool's credibility.
 */
export function confidence(
  level: ConfidenceLevel,
  basis: string,
  rationale: string,
): Confidence {
  return { level, basis, rationale };
}

export function symbolLabel(id: SymbolId): string {
  return describeSymbolId(id);
}
