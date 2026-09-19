import { CONFIDENCE_SCORES } from '../core/model/findings.ts';
import { describeSymbolId, parseSymbolId } from '../core/model/ids.ts';
import type { RunResult } from '../run.ts';

/**
 * Version of the JSON report shape.
 *
 * Consumers should refuse a major version they do not know. Additive changes
 * bump the minor; anything that removes or retypes a field bumps the major.
 */
export const REPORT_SCHEMA_VERSION = '1.0';

export interface JsonReport {
  readonly schemaVersion: string;
  readonly tool: { readonly name: string; readonly version: string };
  readonly repository: string;
  readonly base: { readonly label: string; readonly revision: string };
  readonly branches: ReadonlyArray<{ readonly label: string; readonly revision: string }>;
  readonly summary: {
    readonly findings: number;
    readonly bySeverity: Readonly<Record<string, number>>;
    readonly analysisComplete: boolean;
  };
  readonly mergeability: RunResult['mergeability'];
  readonly pairs: RunResult['pairs'];
  readonly findings: ReadonlyArray<Record<string, unknown>>;
  readonly diagnostics: RunResult['diagnostics'];
  readonly coverage: RunResult['coverage'];
  readonly timings: RunResult['timings'];
}

/**
 * The stable machine-readable form.
 *
 * `confidence` is the level, because that is what Hairline actually knows.
 * `confidenceScore` is a fixed mapping of the level, present only so that
 * consumers which must sort or threshold numerically can do so — it is not a
 * calibrated probability, and the field name and this comment are the only
 * honest way to ship a number at all.
 */
export function toJsonReport(result: RunResult, version: string): JsonReport {
  const bySeverity: Record<string, number> = {};
  for (const finding of result.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: 'hairline', version },
    repository: result.repositoryPath,
    base: { label: result.baseLabel, revision: result.baseRevision },
    branches: result.branches.map((label) => ({
      label,
      revision: result.branchRevisions[label] ?? '',
    })),
    summary: {
      findings: result.findings.length,
      bySeverity,
      analysisComplete: !result.diagnostics.some((d) => d.severity === 'error'),
    },
    mergeability: result.mergeability,
    pairs: result.pairs,
    findings: result.findings.map((finding) => ({
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence.level,
      confidenceScore: CONFIDENCE_SCORES[finding.confidence.level],
      confidenceBasis: finding.confidence.basis,
      confidenceRationale: finding.confidence.rationale,
      analyzer: finding.analyzer,
      branches: finding.branches,
      title: finding.title,
      description: finding.description,
      verification: finding.verification,
      files: finding.files,
      symbols: finding.symbols.map((id) => ({
        id,
        display: describeSymbolId(id),
        ...(parseSymbolId(id) ?? {}),
      })),
      evidence: finding.evidence.map((item) => ({
        kind: item.kind,
        branch: item.branch,
        summary: item.summary,
        ...(item.symbol ? { symbol: item.symbol } : {}),
        ...(item.range ? { location: item.range } : {}),
        ...(item.before !== undefined ? { before: item.before } : {}),
        ...(item.after !== undefined ? { after: item.after } : {}),
      })),
    })),
    diagnostics: result.diagnostics,
    coverage: result.coverage,
    timings: result.timings,
  };
}

export function renderJson(result: RunResult, version: string): string {
  return JSON.stringify(toJsonReport(result, version), null, 2);
}
