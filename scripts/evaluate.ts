import { writeFileSync } from 'node:fs';
import { CORPUS } from '../tests/fixtures/corpus.ts';
import { evaluate } from '../tests/evaluation/harness.ts';
import { style } from '../src/reporters/style.ts';

/**
 * Run the whole corpus and print the numbers.
 *
 * Reproducible: fixtures are built from source in this repository with fixed
 * commit timestamps, so the same checkout produces the same result. Pass
 * `--json <path>` to write the machine-readable report for tracking over time.
 */

const jsonFlag = process.argv.indexOf('--json');
const jsonPath = jsonFlag >= 0 ? process.argv[jsonFlag + 1] : undefined;

const report = await evaluate(CORPUS);

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const mark = (ok: boolean): string => (ok ? style.green('ok') : style.red('FAIL'));

process.stdout.write(`\n${style.bold('Hairline evaluation')}\n`);
process.stdout.write(`${style.dim(`${CORPUS.length} fixtures`)}\n\n`);

const nameWidth = Math.max(...CORPUS.map((f) => f.name.length));
process.stdout.write(
  `  ${'fixture'.padEnd(nameWidth)}  ${'expect'.padEnd(8)} ${'result'.padEnd(7)} ${'tsc(merge)'.padEnd(11)} ${'time'}\n`,
);
process.stdout.write(`  ${style.dim('─'.repeat(nameWidth + 40))}\n`);

for (const outcome of report.outcomes) {
  const cls =
    outcome.classification === 'TP' || outcome.classification === 'TN'
      ? style.green(outcome.classification)
      : style.red(outcome.classification);
  const expect = outcome.expectedConflict ? 'conflict' : 'clean';
  const baseline = outcome.baselineDetected
    ? style.yellow('catches')
    : outcome.expectedConflict
      ? style.magenta('misses')
      : style.dim('n/a');
  process.stdout.write(
    `  ${outcome.fixture.padEnd(nameWidth)}  ${expect.padEnd(8)} ${cls.padEnd(7 + (style.enabled ? 9 : 0))} ` +
      `${baseline.padEnd(11 + (style.enabled ? 9 : 0))} ${String(outcome.hairlineMs).padStart(5)}ms\n`,
  );
  for (const failure of outcome.premiseFailures) {
    process.stdout.write(`    ${style.red('premise')} ${failure}\n`);
  }
  for (const unmet of outcome.unmet) {
    process.stdout.write(
      `    ${style.red('unmet')}   expected a ${unmet.category}` +
        `${unmet.minConfidence ? ` at >= ${unmet.minConfidence} confidence` : ''}` +
        `${unmet.symbolsInclude ? ` naming ${unmet.symbolsInclude.join(', ')}` : ''}\n`,
    );
  }
  if (outcome.classification === 'FP') {
    for (const finding of outcome.findings.slice(0, 2)) {
      process.stdout.write(`    ${style.red('spurious')} [${finding.analyzer}] ${finding.title}\n`);
    }
  }
  if (!outcome.baselineAgreedWithExpectation) {
    process.stdout.write(
      `    ${style.yellow('note')}    fixture declares baseline '${outcome.baselineExpectation}' but tsc ` +
        `${outcome.baselineDetected ? 'reported errors' : 'was clean'}\n`,
    );
  }
}

process.stdout.write(`\n${style.bold('Detection')}\n`);
process.stdout.write(
  `  precision ${style.bold(pct(report.precision))}   recall ${style.bold(pct(report.recall))}   F1 ${style.bold(pct(report.f1))}\n`,
);
process.stdout.write(
  `  TP ${report.truePositives}  FP ${report.falsePositives}  TN ${report.trueNegatives}  FN ${report.falseNegatives}\n`,
);
process.stdout.write(
  `  unmet expectations ${report.unmetExpectations}  ${mark(report.unmetExpectations === 0)}\n`,
);
process.stdout.write(
  `  fixture premise failures ${report.premiseFailures}  ${mark(report.premiseFailures === 0)}\n`,
);

process.stdout.write(`\n${style.bold('Against the incumbent baseline')}\n`);
process.stdout.write(
  style.dim('  Baseline = type-check the tree `git merge-tree` produces, which is what a\n') +
    style.dim('  merge queue with a `tsc --noEmit` required check already does.\n\n'),
);
process.stdout.write(
  `  caught by both              ${report.sharedWithBaseline.length}\n` +
    `  ${style.bold('caught only by Hairline')}     ${style.bold(String(report.beyondBaseline.length))}\n`,
);
for (const name of report.beyondBaseline) {
  process.stdout.write(`    ${style.magenta('+')} ${name}\n`);
}

process.stdout.write(`\n${style.bold('Cost')}\n`);
process.stdout.write(
  `  hairline ${report.totalHairlineMs}ms total, ${Math.round(report.totalHairlineMs / CORPUS.length)}ms per fixture\n`,
);
process.stdout.write(
  `  baseline ${report.totalBaselineMs}ms total, ${Math.round(report.totalBaselineMs / CORPUS.length)}ms per fixture\n`,
);
process.stdout.write('\n');

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedFrom: 'tests/fixtures/corpus.ts',
        fixtures: CORPUS.length,
        precision: report.precision,
        recall: report.recall,
        f1: report.f1,
        counts: {
          truePositives: report.truePositives,
          falsePositives: report.falsePositives,
          trueNegatives: report.trueNegatives,
          falseNegatives: report.falseNegatives,
        },
        unmetExpectations: report.unmetExpectations,
        premiseFailures: report.premiseFailures,
        beyondBaseline: report.beyondBaseline,
        sharedWithBaseline: report.sharedWithBaseline,
        outcomes: report.outcomes.map((o) => ({
          fixture: o.fixture,
          expectedConflict: o.expectedConflict,
          classification: o.classification,
          baselineDetected: o.baselineDetected,
          gitClean: o.gitClean,
          branchesSelfConsistent: o.branchesSelfConsistent,
          premiseFailures: o.premiseFailures,
          hairlineMs: o.hairlineMs,
          findings: o.findings.map((f) => ({
            id: f.id,
            analyzer: f.analyzer,
            category: f.category,
            severity: f.severity,
            confidence: f.confidence.level,
            basis: f.confidence.basis,
            title: f.title,
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

const healthy =
  report.unmetExpectations === 0 && report.premiseFailures === 0 && report.falsePositives === 0;
process.exitCode = healthy ? 0 : 1;
