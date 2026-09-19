import type { ModulePath, SymbolId } from '../model/ids.ts';
import type { Reference, LiteralObservation } from '../model/references.ts';
import type { Finding } from '../model/findings.ts';
import type { BranchChangeSet, SymbolChange } from '../changes/model.ts';
import { SemanticGraph } from '../graph/semantic-graph.ts';

/** One branch, indexed and diffed against the shared base. */
export class BranchView {
  readonly changes: BranchChangeSet;
  readonly graph: SemanticGraph;
  readonly baseGraph: SemanticGraph;

  /** Symbols whose contract (not merely implementation) moved on this branch. */
  readonly #contractChanges = new Map<SymbolId, SymbolChange>();
  /** References this branch introduced or altered, keyed by target. */
  readonly #freshReferencesByTarget = new Map<SymbolId, Reference[]>();
  /** Literal observations this branch introduced or altered. */
  readonly #freshLiterals: LiteralObservation[] = [];

  constructor(changes: BranchChangeSet, baseGraph: SemanticGraph) {
    this.changes = changes;
    this.baseGraph = baseGraph;
    this.graph = new SemanticGraph(changes.headIndex);

    for (const [id, change] of changes.symbolChanges) {
      if (!change.contractStable) this.#contractChanges.set(id, change);
    }

    for (const reference of changes.addedReferences) {
      if (!reference.to) continue;
      const bucket = this.#freshReferencesByTarget.get(reference.to);
      if (bucket) bucket.push(reference);
      else this.#freshReferencesByTarget.set(reference.to, [reference]);
    }

    this.#freshLiterals = [...changes.addedLiterals];
  }

  get label(): string {
    return this.changes.branch;
  }

  contractChanges(): ReadonlyMap<SymbolId, SymbolChange> {
    return this.#contractChanges;
  }

  /**
   * Use sites of `target` that this branch is responsible for.
   *
   * This filter is the single most important precision decision in the engine.
   * A use site that already existed at the base, unchanged, is not evidence of
   * a *cross-branch* problem: the branch that changed the contract could see
   * that use site and had every opportunity to update it, and its own type
   * check or test suite would have caught it if it did not. Only a use site
   * the other branch introduced or edited was genuinely invisible to the
   * branch that moved the contract — and only then can both branches be green
   * in isolation and broken together.
   */
  freshReferencesTo(target: SymbolId): readonly Reference[] {
    return this.#freshReferencesByTarget.get(target) ?? [];
  }

  freshLiterals(): readonly LiteralObservation[] {
    return this.#freshLiterals;
  }

  /** True when this branch added or edited the symbol enclosing a location. */
  owns(symbol: SymbolId): boolean {
    const change = this.changes.symbolChanges.get(symbol);
    return change !== undefined && change.kind !== 'removed';
  }

  changedModules(): readonly ModulePath[] {
    return this.changes.changedFiles;
  }
}

/** What a pairwise analyzer is handed. */
export interface PairContext {
  readonly base: SemanticGraph;
  readonly baseLabel: string;
  /** The branch whose *contract* changes are being considered. */
  readonly producer: BranchView;
  /** The branch whose *use sites* are being considered. */
  readonly consumer: BranchView;
}

export interface Analyzer {
  readonly id: string;
  /** One line, shown by `hairline explain` and in docs. */
  readonly description: string;
  /**
   * Analyzers are run once per *ordered* pair, so an analyzer only has to
   * consider "producer changed a contract, consumer depends on it" and never
   * both directions at once.
   */
  analyze(context: PairContext): Finding[];
}
