/**
 * A tiny argument parser.
 *
 * Hairline's whole argument surface is a handful of flags, and it reads
 * untrusted repositories for a living — so the dependency budget is spent on
 * the type checker and nothing else (ADR-0003). This is the price of that
 * decision, and it is about sixty lines.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly flags: ReadonlyMap<string, string[]>;
  readonly positional: readonly string[];
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'no-color',
  'quiet',
  'no-installed-deps',
  'explain',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      if (name === '') throw new ArgumentError(`Malformed flag: ${token}`);

      if (eq >= 0) {
        append(flags, name, token.slice(eq + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        append(flags, name, 'true');
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ArgumentError(`Flag --${name} needs a value`);
      }
      append(flags, name, value);
      i++;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      throw new ArgumentError(`Unknown short flag: ${token}. Use the long form.`);
    }

    if (command === undefined) command = token;
    else positional.push(token);
  }

  return { command, flags, positional };
}

function append(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name);
  if (existing) existing.push(value);
  else flags.set(name, [value]);
}

export function flagValue(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

export function flagValues(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

export function flagEnabled(args: ParsedArgs, name: string): boolean {
  const value = flagValue(args, name);
  return value === 'true' || value === '';
}
