import process from 'node:process';
import { run } from '../run.ts';
import { renderHuman } from '../reporters/human.ts';
import { renderJson } from '../reporters/json.ts';
import { DEFAULT_ANALYZERS } from '../core/analysis/engine.ts';
import { ArgumentError, flagEnabled, flagValue, flagValues, parseArgs } from './args.ts';

const VERSION = '0.1.0';

/**
 * Exit codes are part of the CLI's contract, because the primary consumer is
 * a CI step deciding whether to stop.
 *
 *   0  analysis ran, nothing found at or above the reporting threshold
 *   1  analysis ran, findings reported
 *   2  invalid usage
 *   3  analysis could not complete (bad revision, unreadable repository)
 *
 * Note 1 means "look at this", not "this is definitely broken" — see the
 * confidence levels in the report.
 */
export const EXIT = {
  clean: 0,
  findings: 1,
  usage: 2,
  failed: 3,
} as const;

const USAGE = `hairline ${VERSION} — semantic integration engine

  Detects conflicts between concurrent branches that Git merges cleanly.

USAGE
  hairline analyze --base <ref> --branch <ref> --branch <ref> [options]
  hairline analyze --base main --branches agent-a agent-b
  hairline analyzers
  hairline --version

OPTIONS
  --base <ref>              Revision the branches diverged from. Default: main
  --branch <ref>            A branch to analyse. Repeat for each branch.
  --branches <ref>...       Several branches as positional values.
  --repo <path>             Repository to analyse. Default: current directory
  --min-confidence <level>  high | medium | low. Default: medium
  --json                    Emit the machine-readable report instead
  --no-installed-deps       Do not read node_modules for dependency types
  --quiet                   Print nothing on success
  --help                    Show this message

EXIT CODES
  0 nothing found   1 findings reported   2 bad usage   3 analysis failed
`;

async function commandAnalyze(args: ReturnType<typeof parseArgs>): Promise<number> {
  const branches = [...flagValues(args, 'branch'), ...flagValues(args, 'branches'), ...args.positional];
  const unique = [...new Set(branches)];

  if (unique.length < 2) {
    process.stderr.write(
      `hairline: analysis needs at least two branches; got ${unique.length}.\n` +
        `Try: hairline analyze --base main --branches agent-a agent-b\n`,
    );
    return EXIT.usage;
  }

  const minimum = flagValue(args, 'min-confidence') ?? 'medium';
  if (minimum !== 'high' && minimum !== 'medium' && minimum !== 'low') {
    process.stderr.write(`hairline: --min-confidence must be high, medium or low\n`);
    return EXIT.usage;
  }

  const result = await run({
    repositoryPath: flagValue(args, 'repo') ?? process.cwd(),
    base: flagValue(args, 'base') ?? 'main',
    branches: unique,
    minimumConfidence: minimum,
    useInstalledDependencies: !flagEnabled(args, 'no-installed-deps'),
  });

  if (flagEnabled(args, 'json')) {
    process.stdout.write(`${renderJson(result, VERSION)}\n`);
  } else if (!flagEnabled(args, 'quiet') || result.findings.length > 0) {
    process.stdout.write(renderHuman(result));
  }

  return result.findings.length > 0 ? EXIT.findings : EXIT.clean;
}

function commandAnalyzers(): number {
  process.stdout.write('\nHairline analyzers\n\n');
  for (const analyzer of DEFAULT_ANALYZERS) {
    process.stdout.write(`  ${analyzer.id.padEnd(20)} ${analyzer.description}\n`);
  }
  process.stdout.write('\n');
  return EXIT.clean;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof ArgumentError) {
      process.stderr.write(`hairline: ${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }

  if (flagEnabled(args, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.clean;
  }
  if (flagEnabled(args, 'help') || args.command === undefined || args.command === 'help') {
    process.stdout.write(USAGE);
    return args.command === undefined && !flagEnabled(args, 'help') ? EXIT.usage : EXIT.clean;
  }

  try {
    switch (args.command) {
      case 'analyze':
      case 'analyse':
        return await commandAnalyze(args);
      case 'analyzers':
        return commandAnalyzers();
      default:
        process.stderr.write(`hairline: unknown command \`${args.command}\`\n\n${USAGE}`);
        return EXIT.usage;
    }
  } catch (error) {
    // Analysis failure must never read as "nothing found".
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`hairline: analysis could not complete.\n  ${message}\n`);
    return EXIT.failed;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith('bin/hairline.js'));

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`hairline: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = EXIT.failed;
    },
  );
}
