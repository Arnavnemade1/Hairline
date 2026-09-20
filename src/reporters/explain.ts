import type { Finding } from '../core/model/findings.ts';
import { CONFIDENCE_SCORES } from '../core/model/findings.ts';
import { describeSymbolId, parseSymbolId } from '../core/model/ids.ts';
import { formatRange } from '../core/model/source.ts';
import type { RunResult } from '../run.ts';
import { sanitize, style, wrapText } from './style.ts';

const WIDTH = 88;

function heading(text: string): string {
  return `\n${style.bold(text)}\n${style.dim('─'.repeat(Math.min(text.length, WIDTH)))}`;
}

function block(text: string, indent = '  '): string {
  return wrapText(sanitize(text), WIDTH - indent.length, indent)
    .map((line, i) => (i === 0 ? indent + line : line))
    .join('\n');
}

/**
 * Everything behind one finding, with its source quoted.
 *
 * The summary report has to stay readable when there are twenty findings, so
 * it shows each one in a few lines. This is the other half: given an id, show
 * the whole chain — what changed, where, what it meets, and the actual code at
 * each site — so a reader can settle the question without leaving the
 * terminal, and without taking the verdict on trust.
 */
export function renderExplanation(result: RunResult, finding: Finding): string {
  const out: string[] = [];

  out.push(heading(`Finding ${finding.id}`));
  out.push(block(finding.title));
  out.push('');
  out.push(
    `  ${style.dim('category  ')} ${finding.category}\n` +
      `  ${style.dim('severity  ')} ${finding.severity}\n` +
      `  ${style.dim('confidence')} ${finding.confidence.level} ` +
      style.dim(`(${finding.confidence.basis})`) +
      `\n  ${style.dim('analyzer  ')} ${finding.analyzer}\n` +
      `  ${style.dim('branches  ')} ${finding.branches.map((b) => sanitize(b)).join(' + ')}`,
  );

  out.push(heading('What Hairline thinks happened'));
  out.push(block(finding.description));

  out.push(heading('Evidence, with the code at each site'));
  for (const [i, item] of finding.evidence.entries()) {
    out.push('');
    out.push(`  ${style.dim(`${i + 1}.`)} ${style.cyan(sanitize(item.branch))}  ${sanitize(item.summary)}`);
    if (item.before !== undefined && item.after !== undefined) {
      out.push(`     ${style.red(`- ${sanitize(item.before)}`)}`);
      out.push(`     ${style.green(`+ ${sanitize(item.after)}`)}`);
    } else if (item.before !== undefined) {
      out.push(`     ${style.red(`was ${sanitize(item.before)}`)}`);
    }

    if (!item.range) continue;
    out.push(`     ${style.dim(formatRange(item.range))}`);

    // Quoting the source is the point of this command: a reader should be able
    // to confirm or dismiss the claim from the code, not from the prose.
    const source = result.sourceFor(item.branch, item.range.module);
    if (source === undefined) {
      out.push(`     ${style.dim('(source unavailable for this revision)')}`);
      continue;
    }
    const lines = source.split('\n');
    const from = Math.max(1, item.range.startLine - 2);
    const to = Math.min(lines.length, item.range.endLine + 2);
    for (let line = from; line <= to; line++) {
      const text = sanitize(lines[line - 1] ?? '');
      const inRange = line >= item.range.startLine && line <= item.range.endLine;
      const gutter = `${String(line).padStart(5)} ${inRange ? style.yellow('│') : style.dim('│')} `;
      out.push(`     ${gutter}${inRange ? text : style.dim(text)}`);
    }
  }

  out.push(heading('Why this confidence, and what it is not'));
  out.push(block(finding.confidence.rationale));
  out.push('');
  out.push(
    block(
      `Confidence is a level set by the rule \`${finding.confidence.basis}\`, not a probability. ` +
        `The JSON report carries ${CONFIDENCE_SCORES[finding.confidence.level]} for consumers that must sort numerically; ` +
        `that number is a fixed mapping of the level and nothing more.`,
    ),
  );

  out.push(heading('Symbols involved'));
  for (const id of finding.symbols) {
    const parts = parseSymbolId(id);
    out.push(
      `  ${sanitize(describeSymbolId(id))}${parts ? style.dim(`  [${parts.kind}]`) : ''}`,
    );
  }

  out.push(heading('What to check'));
  out.push(block(finding.verification));

  const mergeCheck = result.mergeability.find(
    (m) => finding.branches.includes(m.branches[0]) && finding.branches.includes(m.branches[1]),
  );
  if (mergeCheck) {
    out.push('');
    out.push(
      block(
        mergeCheck.gitClean
          ? `Git merges these two branches cleanly, so nothing in the merge itself will surface this.`
          : `Git reports ${mergeCheck.conflictedPaths.length} textual conflict(s) between these branches, so a human will already be looking at the merge.`,
      ),
    );
  }

  out.push('');
  return out.join('\n');
}

/** Findings whose id starts with the given prefix, so short ids work. */
export function findingsMatching(result: RunResult, prefix: string): Finding[] {
  const needle = prefix.toLowerCase();
  return result.findings.filter((f) => f.id.toLowerCase().startsWith(needle));
}
