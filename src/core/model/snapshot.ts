import type { LanguageId, ModulePath, SymbolId } from './ids.ts';
import type { SymbolRecord } from './symbols.ts';
import type { ImportEdge, LiteralObservation, Reference } from './references.ts';
import type { AnalysisDiagnostic, Coverage } from './diagnostics.ts';

/** A file as it exists at one revision. */
export interface FileRecord {
  readonly path: ModulePath;
  /** Content hash (git blob oid when available), used for cache keys. */
  readonly contentHash: string;
  readonly byteLength: number;
  readonly language?: LanguageId;
}

/**
 * The immutable set of files at a revision.
 *
 * Content is fetched lazily through `read` so that a snapshot of a large
 * repository does not have to be held in memory all at once, and so that the
 * git-backed and in-memory implementations look identical to adapters.
 */
export interface RepositorySnapshot {
  /** Human label: a branch name, `HEAD`, or a fixture name. */
  readonly label: string;
  /** Resolved commit oid, when the snapshot came from git. */
  readonly revision?: string;
  readonly files: readonly FileRecord[];
  read(path: ModulePath): string | undefined;
}

/**
 * Everything one adapter learned about one snapshot.
 *
 * Deliberately flat arrays rather than a pre-built graph: the graph is derived
 * (see `core/graph`), and keeping the index serialisable makes caching and
 * fixture assertions straightforward.
 */
export interface SemanticIndex {
  readonly snapshot: RepositorySnapshot;
  readonly language: LanguageId;
  readonly symbols: ReadonlyMap<SymbolId, SymbolRecord>;
  readonly references: readonly Reference[];
  readonly imports: readonly ImportEdge[];
  readonly literals: readonly LiteralObservation[];
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly coverage: Coverage;
}
