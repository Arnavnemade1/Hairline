import type { ModulePath, SymbolId } from '../model/ids.ts';
import type { SymbolRecord } from '../model/symbols.ts';
import type { ImportEdge, LiteralObservation, Reference } from '../model/references.ts';
import type { SemanticIndex } from '../model/snapshot.ts';
import type { AnalysisDiagnostic } from '../model/diagnostics.ts';

/**
 * One way in which a symbol's contract moved.
 *
 * Deltas are the vocabulary the interaction engine reasons in. They are
 * deliberately fine-grained: "the contract changed" is not enough to decide
 * whether a given consumer is affected, but "the second parameter became
 * required" is.
 */
export type ContractDelta =
  | { readonly kind: 'kind-changed'; readonly before: string; readonly after: string }
  | { readonly kind: 'export-removed'; readonly before: string }
  | { readonly kind: 'export-added'; readonly after: string }
  | { readonly kind: 'export-kind-changed'; readonly before: string; readonly after: string }
  | {
      readonly kind: 'parameter-removed';
      readonly name: string;
      readonly index: number;
      readonly wasRequired: boolean;
    }
  | {
      readonly kind: 'parameter-added';
      readonly name: string;
      readonly index: number;
      readonly required: boolean;
    }
  | {
      readonly kind: 'parameter-type-changed';
      readonly name: string;
      readonly index: number;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'parameter-optionality-changed';
      readonly name: string;
      readonly index: number;
      readonly nowRequired: boolean;
    }
  | {
      readonly kind: 'parameter-default-changed';
      readonly name: string;
      readonly index: number;
      readonly before: string | undefined;
      readonly after: string | undefined;
    }
  | { readonly kind: 'required-arity-changed'; readonly before: number; readonly after: number }
  | { readonly kind: 'return-type-changed'; readonly before: string; readonly after: string }
  | { readonly kind: 'overload-count-changed'; readonly before: number; readonly after: number }
  | { readonly kind: 'member-added'; readonly name: string; readonly typeText: string; readonly optional: boolean }
  | { readonly kind: 'member-removed'; readonly name: string; readonly typeText: string }
  | {
      readonly kind: 'member-type-changed';
      readonly name: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'member-optionality-changed';
      readonly name: string;
      readonly nowRequired: boolean;
    }
  | { readonly kind: 'member-renamed'; readonly before: string; readonly after: string; readonly typeText: string }
  | { readonly kind: 'literal-removed'; readonly value: string }
  | { readonly kind: 'literal-added'; readonly value: string }
  | { readonly kind: 'literal-openness-changed'; readonly nowOpen: boolean }
  | { readonly kind: 'nullability-changed'; readonly nowNullable: boolean; readonly before: string; readonly after: string }
  | { readonly kind: 'type-text-changed'; readonly before: string; readonly after: string }
  | { readonly kind: 'heritage-changed'; readonly before: readonly string[]; readonly after: readonly string[] }
  | { readonly kind: 'initializer-changed'; readonly before: string | undefined; readonly after: string | undefined }
  | { readonly kind: 'body-changed'; readonly before: string; readonly after: string }
  | { readonly kind: 'moved'; readonly before: ModulePath; readonly after: ModulePath };

export type ContractDeltaKind = ContractDelta['kind'];

export type ChangeKind = 'added' | 'removed' | 'modified';

/** What a symbol did between two revisions. */
export interface SymbolChange {
  readonly id: SymbolId;
  readonly kind: ChangeKind;
  readonly before?: SymbolRecord;
  readonly after?: SymbolRecord;
  readonly deltas: readonly ContractDelta[];
  /**
   * True when every delta is implementation-only (`body-changed`).
   * Such a change cannot break a consumer *statically*, which is exactly why
   * it is tracked separately rather than discarded.
   */
  readonly contractStable: boolean;
}

/** A rename Hairline believes it detected, with the evidence for believing it. */
export interface RenameCandidate {
  readonly from: SymbolId;
  readonly to: SymbolId;
  /** 0..1 structural similarity; see `detectRenames`. */
  readonly similarity: number;
  readonly reason: string;
}

/** Everything one branch did, relative to the merge base. */
export interface BranchChangeSet {
  readonly branch: string;
  readonly baseLabel: string;
  readonly baseIndex: SemanticIndex;
  readonly headIndex: SemanticIndex;
  readonly symbolChanges: ReadonlyMap<SymbolId, SymbolChange>;
  readonly renames: readonly RenameCandidate[];
  /** References present on the branch but not at the base. */
  readonly addedReferences: readonly Reference[];
  /** References present at the base but not on the branch. */
  readonly removedReferences: readonly Reference[];
  readonly addedLiterals: readonly LiteralObservation[];
  readonly removedLiterals: readonly LiteralObservation[];
  readonly addedImports: readonly ImportEdge[];
  readonly removedImports: readonly ImportEdge[];
  readonly changedFiles: readonly ModulePath[];
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

/**
 * Which kinds of consumer a delta can break.
 *
 * Used to decide whether a given reference kind is actually exposed to a
 * given change — the difference between "these two symbols are related" and
 * "this change reaches this use site".
 */
export interface DeltaImpact {
  /** Call sites: `foo()`. */
  readonly callers: boolean;
  /** Value reads and property accesses. */
  readonly readers: boolean;
  /** Type positions, `implements`, `extends`. */
  readonly implementers: boolean;
  /** Import statements naming the symbol. */
  readonly importers: boolean;
  /** True when the delta cannot be shown statically to break anything. */
  readonly behavioralOnly: boolean;
}

const NONE: DeltaImpact = {
  callers: false,
  readers: false,
  implementers: false,
  importers: false,
  behavioralOnly: false,
};

export function deltaImpact(delta: ContractDelta): DeltaImpact {
  switch (delta.kind) {
    case 'export-removed':
    case 'export-kind-changed':
    case 'moved':
      return { ...NONE, importers: true, callers: true, readers: true, implementers: true };
    case 'kind-changed':
      return { ...NONE, callers: true, readers: true, implementers: true, importers: true };
    case 'parameter-removed':
    case 'parameter-added':
    case 'parameter-type-changed':
    case 'parameter-optionality-changed':
    case 'required-arity-changed':
    case 'overload-count-changed':
      return { ...NONE, callers: true };
    case 'parameter-default-changed':
      return { ...NONE, callers: true, behavioralOnly: true };
    case 'return-type-changed':
    case 'nullability-changed':
      return { ...NONE, callers: true, readers: true };
    case 'member-removed':
    case 'member-renamed':
    case 'member-type-changed':
    case 'member-optionality-changed':
      return { ...NONE, readers: true, implementers: true };
    case 'member-added':
      return { ...NONE, implementers: true };
    case 'literal-removed':
    case 'literal-openness-changed':
      return { ...NONE, readers: true, callers: true, implementers: true };
    case 'literal-added':
      return { ...NONE, readers: true, implementers: true };
    case 'type-text-changed':
    case 'heritage-changed':
      return { ...NONE, readers: true, implementers: true, callers: true };
    case 'initializer-changed':
      return { ...NONE, readers: true, behavioralOnly: true };
    case 'body-changed':
      return { ...NONE, behavioralOnly: true };
    case 'export-added':
      return NONE;
  }
}

/** Human phrasing for a delta, used in evidence lines. */
export function describeDelta(delta: ContractDelta): string {
  switch (delta.kind) {
    case 'kind-changed':
      return `declaration kind changed from ${delta.before} to ${delta.after}`;
    case 'export-removed':
      return `no longer exported (was ${delta.before})`;
    case 'export-added':
      return `newly exported (${delta.after})`;
    case 'export-kind-changed':
      return `export changed from ${delta.before} to ${delta.after}`;
    case 'parameter-removed':
      return `parameter \`${delta.name}\` (position ${delta.index + 1}) removed`;
    case 'parameter-added':
      return `${delta.required ? 'required' : 'optional'} parameter \`${delta.name}\` added at position ${delta.index + 1}`;
    case 'parameter-type-changed':
      return `parameter \`${delta.name}\`: ${delta.before} -> ${delta.after}`;
    case 'parameter-optionality-changed':
      return `parameter \`${delta.name}\` became ${delta.nowRequired ? 'required' : 'optional'}`;
    case 'parameter-default-changed':
      return `default for \`${delta.name}\`: ${delta.before ?? '(none)'} -> ${delta.after ?? '(none)'}`;
    case 'required-arity-changed':
      return `required argument count ${delta.before} -> ${delta.after}`;
    case 'return-type-changed':
      return `return type ${delta.before} -> ${delta.after}`;
    case 'overload-count-changed':
      return `overload count ${delta.before} -> ${delta.after}`;
    case 'member-added':
      return `member \`${delta.name}${delta.optional ? '?' : ''}: ${delta.typeText}\` added`;
    case 'member-removed':
      return `member \`${delta.name}: ${delta.typeText}\` removed`;
    case 'member-type-changed':
      return `member \`${delta.name}\`: ${delta.before} -> ${delta.after}`;
    case 'member-optionality-changed':
      return `member \`${delta.name}\` became ${delta.nowRequired ? 'required' : 'optional'}`;
    case 'member-renamed':
      return `member \`${delta.before}\` renamed to \`${delta.after}\``;
    case 'literal-removed':
      return `literal ${delta.value} removed from the admissible set`;
    case 'literal-added':
      return `literal ${delta.value} added to the admissible set`;
    case 'literal-openness-changed':
      return delta.nowOpen
        ? `type widened to admit non-literal values`
        : `type narrowed to a closed literal set`;
    case 'nullability-changed':
      return delta.nowNullable
        ? `became nullable: ${delta.before} -> ${delta.after}`
        : `no longer nullable: ${delta.before} -> ${delta.after}`;
    case 'type-text-changed':
      return `type ${delta.before} -> ${delta.after}`;
    case 'heritage-changed':
      return `heritage [${delta.before.join(', ')}] -> [${delta.after.join(', ')}]`;
    case 'initializer-changed':
      return `initializer ${delta.before ?? '(none)'} -> ${delta.after ?? '(none)'}`;
    case 'body-changed':
      return `implementation changed (${delta.before.slice(0, 8)} -> ${delta.after.slice(0, 8)})`;
    case 'moved':
      return `moved from ${delta.before} to ${delta.after}`;
  }
}
