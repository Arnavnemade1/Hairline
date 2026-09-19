/**
 * Hairline's public API.
 *
 * Everything exported here is written against the language-agnostic model;
 * nothing in it mentions TypeScript except the adapter itself. Adding a
 * language means implementing `LanguageAdapter` and registering it.
 */

export { run, type RunOptions, type RunResult, type MergeCheck } from './run.ts';
export {
  analyze,
  deduplicate,
  DEFAULT_ANALYZERS,
  type AnalysisResult,
  type BranchInput,
  type EngineOptions,
  type PairSummary,
} from './core/analysis/engine.ts';
export { BranchView, type Analyzer, type PairContext } from './core/analysis/context.ts';
export { SemanticGraph } from './core/graph/semantic-graph.ts';
export { diffIndexes, contractDeltas, detectRenames } from './core/changes/differ.ts';

export type {
  BranchChangeSet,
  ChangeKind,
  ContractDelta,
  ContractDeltaKind,
  DeltaImpact,
  RenameCandidate,
  SymbolChange,
} from './core/changes/model.ts';
export { describeDelta, deltaImpact } from './core/changes/model.ts';

export type {
  Confidence,
  ConfidenceLevel,
  Evidence,
  EvidenceKind,
  Finding,
  FindingCategory,
  Severity,
} from './core/model/findings.ts';
export { CONFIDENCE_SCORES, compareFindings } from './core/model/findings.ts';

export type {
  Contract,
  CallableShape,
  LiteralSet,
  MemberShape,
  ObjectShape,
  ParameterShape,
} from './core/model/contracts.ts';
export { displayTypeText } from './core/model/contracts.ts';

export type {
  LanguageId,
  ModulePath,
  SymbolId,
  SymbolIdParts,
  SymbolKind,
} from './core/model/ids.ts';
export { describeSymbolId, makeSymbolId, parseSymbolId } from './core/model/ids.ts';

export type { FileRecord, RepositorySnapshot, SemanticIndex } from './core/model/snapshot.ts';
export type { SymbolRecord, ExportKind } from './core/model/symbols.ts';
export type {
  ImportEdge,
  LiteralObservation,
  Reference,
  ReferenceKind,
} from './core/model/references.ts';
export type {
  AnalysisDiagnostic,
  Coverage,
  DiagnosticCode,
} from './core/model/diagnostics.ts';
export { resolutionRate } from './core/model/diagnostics.ts';
export type { SourceRange } from './core/model/source.ts';
export { formatRange } from './core/model/source.ts';

export { AdapterRegistry, type AdapterCapabilities, type LanguageAdapter } from './languages/adapter.ts';
export { TypeScriptAdapter } from './languages/typescript/adapter.ts';

export { GitRepository } from './git/repository.ts';
export {
  buildSnapshot,
  buildSnapshotFromTree,
  memorySnapshot,
  DEFAULT_POLICY,
  type SnapshotPolicy,
} from './git/snapshot.ts';

export { renderHuman } from './reporters/human.ts';
export { renderJson, toJsonReport, REPORT_SCHEMA_VERSION, type JsonReport } from './reporters/json.ts';
