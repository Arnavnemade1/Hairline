import { execFile } from 'node:child_process';

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly result: GitResult;

  constructor(message: string, args: readonly string[], result: GitResult) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.result = result;
  }
}

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Run git with an explicit argument vector.
 *
 * Never goes through a shell, so branch names and paths coming from a
 * repository can never be interpreted as commands. `allowFailure` exists
 * because several plumbing commands (`merge-tree`, `rev-parse --verify`)
 * use the exit code to carry an answer rather than an error.
 */
export function git(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean; input?: string; encoding?: 'utf8' | 'buffer' } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['--no-pager', ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        const result: GitResult = { stdout, stderr, code };
        if (error && !options.allowFailure) {
          reject(new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || error.message}`, args, result));
          return;
        }
        resolve(result);
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** Raw-bytes variant, used for blob reads where content may not be valid UTF-8. */
export function gitBuffer(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['--no-pager', ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error && !(error as { code?: number }).code) {
          reject(new GitError(`git ${args.join(' ')} failed: ${String(stderr)}`, args, {
            stdout: '',
            stderr: String(stderr),
            code: 1,
          }));
          return;
        }
        resolve({
          stdout: stdout as unknown as Buffer,
          code: (error as { code?: number } | null)?.code ?? 0,
        });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}
