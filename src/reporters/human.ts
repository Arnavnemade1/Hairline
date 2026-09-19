import type { Finding, Severity } from '../core/model/findings.ts';
import type { AnalysisDiagnostic } from '../core/model/diagnostics.ts';
import { formatRange } from '../core/model/source.ts';
import { describeSymbolId } from '../core/model/ids.ts';
import type { RunResult } from '../run.ts';
import { style, wrapText } from './style.ts';

const WIDTH = 88;

const SEVERITY_STYLE: Record<Severity, (t: string) => string> = {
  high: style.red,
  medium: style.yellow,
  low: style.blue,
  info: style.dim,
};

const CONFIDENCE_STYLE = {
  high: style.green,
  medium: style.yellow,
  low: style.dim,
} as const;

function heading(text: string): string {
  return `${style.bold(text)}\n${style.dim('─'.repeat(Math.min(text.length, WIDTH)))}`;
}

function renderFinding(finding: Finding, ordinal: number, total: number): string {
  const out: string[] = [];
  const badge = SEVERITY_STYLE[finding.severity](finding.severity.toUpperCase().padEnd(6));
  const confidence = CONFIDENCE_STYLE[finding.confidence.level](
    `confidence: ${finding.confidence.level}`,
  );

  out.push('');
  out.push(
    `${style.dim(`[${ordinal}/${total}]`)} ${badge} ${style.bold(finding.title)}`,
  );
  out.push(
    `        ${style.dim(finding.category)}  ${confidence}  ${style.dim(`id ${finding.id}`)}`,
  );
  out.push('');

  for (const line of wrapText(finding.description, WIDTH - 8, '')) {
    out.push(`        ${line}`);
  }

  out.push('');
  out.push(`        ${style.bold('Evidence')}`);
  for (const item of finding.evidence) {
    const where = item.range ? style.dim(`  ${formatRange(item.range)}`) : '';
    out.push(`          ${style.cyan(item.branch)}  ${item.summary}${where}`);
    if (item.before !== undefined && item.after !== undefined) {
      out.push(`            ${style.red(`- ${item.before}`)}`);
      out.push(`            ${style.green(`+ ${item.after}`)}`);
    } else if (item.before !== undefined) {
      out.push(`            ${style.red(`was ${item.before}`)}`);
    }
  }

  out.push('');
  out.push(`        ${style.bold('Why this confidence')}`);
  for (const line of wrapText(finding.confidence.rationale, WIDTH - 10, '')) {
    out.push(`          ${style.dim(line)}`);
  }

  out.push('');
  out.push(`        ${style.bold('Suggested check')}`);
  for (const line of wrapText(finding.verification, WIDTH - 10, '')) {
    out.push(`          ${line}`);
  }

  if (finding.symbols.length > 0) {
    out.push('');
    out.push(
      `        ${style.dim('symbols:')} ${finding.symbols.map((s) => describeSymbolId(s)).join(', ')}`,
    );
  }

  return out.join('\n');
}

/**
 * Collapse diagnostics that say the same thing about the same place.
 *
 * Every revision is indexed separately, so an unresolved import in a file no
 * branch touched is reported once per revision. Three identical lines do not
 * tell a reader anything the first one did not, and they crowd out the
 * diagnostics that differ.
 */
function renderDiagnostics(diagnostics: readonly AnalysisDiagnostic[]): string[] {
  const out: string[] = [];
  const notable = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning');
  if (notable.length === 0) return out;

  const unique = new Map<string, { diagnostic: AnalysisDiagnostic; count: number }>();
  for (const diagnostic of notable) {
    const key = `${diagnostic.code}|${diagnostic.module ?? ''}|${diagnostic.message}`;
    const existing = unique.get(key);
    if (existing) existing.count++;
    else unique.set(key, { diagnostic, count: 1 });
  }

  const ordered = [...unique.values()].sort(
    (a, b) =>
      (a.diagnostic.severity === 'error' ? 0 : 1) - (b.diagnostic.severity === 'error' ? 0 : 1),
  );

  out.push('');
  out.push(heading('Analysis completeness'));
  for (const { diagnostic, count } of ordered.slice(0, 10)) {
    const marker = diagnostic.severity === 'error' ? style.red('!') : style.yellow('?');
    const where = diagnostic.module ? style.dim(` (${diagnostic.module})`) : '';
    const repeats = count > 1 ? style.dim(` [x${count}]`) : '';
    out.push(`  ${marker} ${diagnostic.message}${where}${repeats}`);
  }
  const hidden = ordered.length - 10;
  if (hidden > 0) out.push(style.dim(`  ... and ${hidden} more distinct issue(s)`));
  return out;
}

/**
 * Render a run for a person reading a terminal.
 *
 * Deliberately never prints the graph. The graph is how Hairline arrives at
 * an answer; the answer is what changed, what it meets, and what to check.
 */
export function renderHuman(result: RunResult): string {
  const out: string[] = [];

  out.push('');
  out.push(heading('Hairline'));
  out.push(
    `  base      ${style.bold(result.baseLabel)} ${style.dim(`(${result.baseRevision.slice(0, 10)})`)}`,
  );
  for (const branch of result.branches) {
    const changed = result.changedSymbols[branch] ?? 0;
    out.push(
      `  branch    ${style.bold(branch)} ${style.dim(`(${(result.branchRevisions[branch] ?? '').slice(0, 10)})`)} ` +
        style.dim(`${changed} contract change${changed === 1 ? '' : 's'}`),
    );
  }

  if (result.mergeability.length > 0) {
    out.push('');
    for (const check of result.mergeability) {
      const verdict = check.gitClean
        ? style.green('git merges cleanly')
        : style.yellow(`git reports ${check.conflictedPaths.length} textual conflict(s)`);
      out.push(`  ${check.branches[0]} + ${check.branches[1]}: ${verdict}`);
    }
  }

  const skipped = result.pairs.filter((p) => !p.analysed);
  if (skipped.length > 0) {
    out.push('');
    for (const pair of skipped) {
      out.push(
        style.dim(`  ${pair.branches[0]} + ${pair.branches[1]}: not analysed — ${pair.reason}`),
      );
    }
  }

  out.push('');
  if (result.findings.length === 0) {
    const incomplete = result.diagnostics.some((d) => d.severity === 'error');
    out.push(
      incomplete
        ? style.yellow('  No interactions found, but the analysis was incomplete — see below.')
        : style.green('  No likely semantic integration conflicts found.'),
    );
    out.push(
      style.dim(
        `  Compared ${result.branches.length} branches across ${result.pairs.filter((p) => p.analysed).length} interacting pair(s).`,
      ),
    );
  } else {
    const high = result.findings.filter((f) => f.severity === 'high').length;
    out.push(
      style.bold(
        `  ${result.findings.length} likely semantic integration ${result.findings.length === 1 ? 'conflict' : 'conflicts'}` +
          (high > 0 ? ` (${high} high severity)` : ''),
      ),
    );
    result.findings.forEach((finding, i) => {
      out.push(renderFinding(finding, i + 1, result.findings.length));
    });
  }

  out.push(...renderDiagnostics(result.diagnostics));

  out.push('');
  const totalFiles = Object.values(result.coverage).reduce((sum, c) => sum + c.filesIndexed, 0);
  out.push(
    style.dim(
      `  indexed ${totalFiles} file(s) across ${Object.keys(result.coverage).length} revision(s) ` +
        `in ${result.timings.indexMs ?? 0}ms; analysis ${result.timings.analysisMs ?? 0}ms; total ${result.timings.totalMs ?? 0}ms`,
    ),
  );
  out.push('');

  return out.join('\n');
}
