import type { ModulePath } from './ids.ts';

/**
 * A location in a file *at a particular revision*.
 *
 * Positions are explicitly **not** part of identity (see `ids.ts`). They exist
 * so findings can point a human at real code, and they are only ever valid in
 * combination with the revision they were captured from.
 */
export interface SourceRange {
  readonly module: ModulePath;
  /** 1-based, to match what editors and `git blame` show. */
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export function formatRange(range: SourceRange): string {
  return `${range.module}:${range.startLine}:${range.startColumn}`;
}

export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  if (a.module !== b.module) return false;
  if (a.endLine < b.startLine || b.endLine < a.startLine) return false;
  return true;
}
