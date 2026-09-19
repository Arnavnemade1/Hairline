import type { ModulePath, SymbolId, SymbolKind } from './ids.ts';
import type { SourceRange } from './source.ts';
import type { Contract } from './contracts.ts';

export type ExportKind =
  /** Not visible outside its module. */
  | 'none'
  | 'named'
  | 'default'
  /** `export { x } from './y'` — visible here, but declared elsewhere. */
  | 'reexport';

export interface SymbolFlags {
  readonly abstract?: boolean;
  readonly async?: boolean;
  readonly generator?: boolean;
  readonly declare?: boolean;
  readonly const?: boolean;
  readonly deprecated?: boolean;
}

/** A declaration Hairline can name, compare across revisions, and hang edges off. */
export interface SymbolRecord {
  readonly id: SymbolId;
  readonly kind: SymbolKind;
  /** Local name as written, e.g. `getUser`. */
  readonly name: string;
  readonly module: ModulePath;
  /** Enclosing declaration, if any. */
  readonly parent?: SymbolId;
  readonly exported: ExportKind;
  readonly contract: Contract;
  readonly flags: SymbolFlags;
  /** Where the declaration was at the revision this record came from. */
  readonly range: SourceRange;
  /** First line of the leading doc comment, when present. */
  readonly docSummary?: string;
}
