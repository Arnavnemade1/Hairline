import { execFileSync } from 'node:child_process';
import { buildFixture } from '../tests/fixtures/build.ts';
import { fixtureByName, CORPUS } from '../tests/fixtures/corpus.ts';
import { runBaseline } from '../src/evaluation/baseline.ts';
import { run } from '../src/run.ts';
import { renderHuman } from '../src/reporters/human.ts';
import { style } from '../src/reporters/style.ts';

/**
 * The demonstration from the README, run for real.
 *
 * Every claim it prints is produced by actually doing the thing: git really
 * merges the branches, the type checker really runs on each branch and on the
 * merged tree, and Hairline really analyses the repository. Nothing is
 * narrated from a script.
 */

const name = process.argv[2] ?? 'union-member-removed--widened-consumer';
const fixture = fixtureByName(name);
if (!fixture) {
  process.stderr.write(
    `Unknown fixture: ${name}\n\nAvailable:\n${CORPUS.map((f) => `  ${f.name}`).join('\n')}\n`,
  );
  process.exit(2);
}

const built = buildFixture(fixture);

function section(title: string): void {
  process.stdout.write(`\n${style.bold(title)}\n${style.dim('─'.repeat(title.length))}\n`);
}

try {
  process.stdout.write(`\n${style.bold(style.magenta('Hairline demonstration'))}\n`);
  process.stdout.write(`${style.dim(fixture.name)}\n\n`);
  process.stdout.write(`  ${fixture.summary}\n`);

  section('1. Does Git merge these branches?');
  // merge-tree uses its exit code to carry the answer, so a non-zero exit is
  // a result rather than an error and must not abort the demo.
  let mergeOutput = '';
  let mergeClean = true;
  try {
    mergeOutput = execFileSync(
      'git',
      ['merge-tree', '--write-tree', '--name-only', built.branchA, built.branchB],
      { cwd: built.repositoryPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    mergeClean = false;
    mergeOutput = String((error as { stdout?: string }).stdout ?? '').trim();
  }
  process.stdout.write(`  $ git merge-tree --write-tree ${built.branchA} ${built.branchB}\n`);
  process.stdout.write(`  ${style.dim(mergeOutput.split('\n')[0] ?? '')}\n`);
  process.stdout.write(
    mergeClean
      ? `  ${style.green('exit 0 — merges cleanly, no textual conflict')}\n`
      : `  ${style.yellow('exit 1 — git reports a textual conflict here')}\n` +
        `  ${style.dim('Git catches this one. Most of the corpus is the cases it does not.')}\n`,
  );

  section('2. Does each branch pass a type check on its own?');
  const baseline = await runBaseline(built.repositoryPath, built.branchA, built.branchB);
  for (const [label, errors] of Object.entries(baseline.branchErrors)) {
    process.stdout.write(
      `  ${label.padEnd(10)} ${errors.length === 0 ? style.green('PASS') : style.red(`FAIL (${errors.length})`)}\n`,
    );
  }

  section('3. Does a type check of the merged tree catch it?');
  if (!baseline.gitClean) {
    process.stdout.write(
      `  ${style.dim('Not applicable — there is no clean merged tree to check.')}\n`,
    );
  } else if (baseline.mergedErrors.length === 0) {
    process.stdout.write(
      `  ${style.green('PASS')} — tsc reports no errors on the merged tree.\n` +
        `  ${style.dim('This is what a merge queue with a `tsc --noEmit` required check would see.')}\n`,
    );
  } else {
    process.stdout.write(
      `  ${style.yellow(`${baseline.mergedErrors.length} error(s)`)} on the merged tree:\n`,
    );
    for (const error of baseline.mergedErrors.slice(0, 4)) {
      process.stdout.write(`    ${style.dim(`${error.module}:${error.line}`)} ${error.message}\n`);
    }
    process.stdout.write(
      `  ${style.dim('A merge queue would catch this — but only after both PRs are approved and queued.')}\n`,
    );
  }

  section('4. What does Hairline say?');
  const result = await run({
    repositoryPath: built.repositoryPath,
    base: built.base,
    branches: [built.branchA, built.branchB],
    minimumConfidence: 'low',
  });
  process.stdout.write(renderHuman(result));
} finally {
  built.cleanup();
}
