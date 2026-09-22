import { writeFileSync } from 'node:fs';
import { measureRealWorld } from '../src/evaluation/real-world.ts';
import { style } from '../src/reporters/style.ts';

/**
 * Run Hairline over a real repository's merge history.
 *
 *   npm run validate -- --repo <path> [--limit 40] [--json out.json]
 *
 * See `src/evaluation/real-world.ts` for what the resulting number means and,
 * more importantly, what it does not.
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repositoryPath = flag('repo');
if (!repositoryPath) {
  process.stderr.write('usage: validate-real-world --repo <path> [--limit N] [--json out.json]\n');
  process.exit(2);
}

const limit = Number(flag('limit') ?? 40);
const jsonPath = flag('json');

process.stdout.write(`\n${style.bold('Hairline real-world validation')}\n`);
process.stdout.write(style.dim(`  ${repositoryPath}\n`));
process.stdout.write(
  style.dim(`  Every two-parent merge commit is a branch pair that really diverged and merged.\n\n`),
);

const report = await measureRealWorld({
  repositoryPath,
  limit,
  minimumConfidence: 'low',
  onProgress(index, total, outcome) {
    const marker = outcome.error
      ? style.red('ERR ')
      : outcome.findings.length > 0
        ? style.yellow(`${outcome.findings.length} find`)
        : style.green('clean');
    process.stdout.write(
      `  ${String(index).padStart(3)}/${total}  ${outcome.mergeCommit.slice(0, 8)}  ${marker.padEnd(
        style.enabled ? 16 : 6,
      )} ${String(outcome.elapsedMs).padStart(6)}ms  ${style.dim(outcome.subject.slice(0, 48))}\n`,
    );
    for (const finding of outcome.findings) {
      process.stdout.write(
        `        ${style.yellow('→')} [${finding.confidence.level}] ${finding.analyzer}: ${finding.title.slice(0, 96)}\n`,
      );
    }
    if (outcome.error) process.stdout.write(`        ${style.red(outcome.error.slice(0, 120))}\n`);
  },
});

const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${((100 * n) / of).toFixed(1)}%`);

process.stdout.write(`\n${style.bold('Result')}\n`);
process.stdout.write(`  merge commits examined      ${report.pairsConsidered}\n`);
process.stdout.write(`  pairs analysed              ${report.pairsAnalysed}\n`);
process.stdout.write(`  analysis failures           ${report.failures}\n`);
process.stdout.write(
  `  ${style.bold('pairs with any finding')}      ${style.bold(String(report.pairsWithFindings))}  ` +
    `(${pct(report.pairsWithFindings, report.pairsAnalysed)} of analysed)\n`,
);
process.stdout.write(`  total findings              ${report.totalFindings}\n`);

if (report.totalFindings > 0) {
  process.stdout.write(`\n  by confidence\n`);
  for (const [level, n] of Object.entries(report.byConfidence).sort()) {
    process.stdout.write(`    ${level.padEnd(8)} ${n}\n`);
  }
  process.stdout.write(`  by analyzer\n`);
  for (const [analyzer, n] of Object.entries(report.byAnalyzer).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${analyzer.padEnd(20)} ${n}\n`);
  }
}

process.stdout.write(`\n${style.bold('Cost and coverage')}\n`);
process.stdout.write(`  median time per pair        ${report.medianMs}ms\n`);
process.stdout.write(
  `  mean reference resolution   ${(100 * report.meanResolutionRate).toFixed(1)}%\n`,
);

process.stdout.write(
  `\n${style.dim('  These merges shipped, so each finding is a *candidate* false positive.')}\n` +
    `${style.dim('  Shipping is not proof of correctness: Brun et al. (IEEE TSE 2013) found')}\n` +
    `${style.dim('  over 9% of textually clean merges fail to build or pass tests. Treat this rate as an')}\n` +
    `${style.dim('  upper bound, and read the individual findings rather than assuming them wrong.')}\n\n`,
);

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        repository: report.repository,
        pairsConsidered: report.pairsConsidered,
        pairsAnalysed: report.pairsAnalysed,
        pairsWithFindings: report.pairsWithFindings,
        totalFindings: report.totalFindings,
        byConfidence: report.byConfidence,
        byAnalyzer: report.byAnalyzer,
        failures: report.failures,
        medianMs: report.medianMs,
        meanResolutionRate: report.meanResolutionRate,
        outcomes: report.outcomes.map((o) => ({
          mergeCommit: o.mergeCommit,
          subject: o.subject,
          base: o.base,
          parents: o.parents,
          filesIndexed: o.filesIndexed,
          resolutionRate: o.resolutionRate,
          elapsedMs: o.elapsedMs,
          error: o.error,
          findings: o.findings.map((f) => ({
            id: f.id,
            analyzer: f.analyzer,
            category: f.category,
            severity: f.severity,
            confidence: f.confidence.level,
            basis: f.confidence.basis,
            title: f.title,
            files: f.files,
          })),
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  process.stdout.write(`${style.dim(`wrote ${jsonPath}`)}\n\n`);
}
