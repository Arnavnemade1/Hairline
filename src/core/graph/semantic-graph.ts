import type { ModulePath, SymbolId, SymbolKind } from '../model/ids.ts';
import type { SymbolRecord } from '../model/symbols.ts';
import type { ImportEdge, LiteralObservation, Reference } from '../model/references.ts';
import type { SemanticIndex } from '../model/snapshot.ts';

/**
 * Queryable view over one snapshot's index.
 *
 * Deliberately an in-memory structure built from plain arrays rather than a
 * graph database. The engine's hot questions are all adjacency lookups
 * ("who references this symbol?", "which modules import this one?"), which a
 * few hash maps answer in constant time. A database would add operational
 * weight, a serialisation boundary, and a second source of truth, in exchange
 * for capabilities — persistence, cross-process queries — the MVP does not
 * use. See docs/decisions.md ADR-0006.
 */
export class SemanticGraph {
  readonly index: SemanticIndex;

  readonly #incoming = new Map<SymbolId, Reference[]>();
  readonly #outgoing = new Map<SymbolId, Reference[]>();
  readonly #byModule = new Map<ModulePath, SymbolRecord[]>();
  readonly #children = new Map<SymbolId, SymbolRecord[]>();
  readonly #literalsByTarget = new Map<SymbolId, LiteralObservation[]>();
  readonly #literalsByValue = new Map<string, LiteralObservation[]>();
  readonly #importersOf = new Map<ModulePath, ImportEdge[]>();
  readonly #importsFrom = new Map<ModulePath, ImportEdge[]>();

  constructor(index: SemanticIndex) {
    this.index = index;

    for (const symbol of index.symbols.values()) {
      push(this.#byModule, symbol.module, symbol);
      if (symbol.parent) push(this.#children, symbol.parent, symbol);
    }
    for (const reference of index.references) {
      push(this.#outgoing, reference.from, reference);
      if (reference.to) push(this.#incoming, reference.to, reference);
    }
    for (const observation of index.literals) {
      if (observation.against) push(this.#literalsByTarget, observation.against, observation);
      if (observation.viaSymbol) push(this.#literalsByTarget, observation.viaSymbol, observation);
      push(this.#literalsByValue, observation.value, observation);
    }
    for (const edge of index.imports) {
      push(this.#importsFrom, edge.from, edge);
      if (edge.to) push(this.#importersOf, edge.to, edge);
    }
  }

  symbol(id: SymbolId): SymbolRecord | undefined {
    return this.index.symbols.get(id);
  }

  symbolsInModule(module: ModulePath): readonly SymbolRecord[] {
    return this.#byModule.get(module) ?? [];
  }

  childrenOf(id: SymbolId): readonly SymbolRecord[] {
    return this.#children.get(id) ?? [];
  }

  /** Use sites that name this symbol. */
  referencesTo(id: SymbolId): readonly Reference[] {
    return this.#incoming.get(id) ?? [];
  }

  /** References originating inside this symbol. */
  referencesFrom(id: SymbolId): readonly Reference[] {
    return this.#outgoing.get(id) ?? [];
  }

  /** Literal observations constrained by this symbol, directly or via its type. */
  literalsAgainst(id: SymbolId): readonly LiteralObservation[] {
    return this.#literalsByTarget.get(id) ?? [];
  }

  /** Every observation of a given literal value, wherever it appears. */
  literalsWithValue(value: string): readonly LiteralObservation[] {
    return this.#literalsByValue.get(value) ?? [];
  }

  importsFrom(module: ModulePath): readonly ImportEdge[] {
    return this.#importsFrom.get(module) ?? [];
  }

  importersOf(module: ModulePath): readonly ImportEdge[] {
    return this.#importersOf.get(module) ?? [];
  }

  /**
   * Nearest enclosing symbol of one of the given kinds, following parent links.
   *
   * A call site's `from` is the nearest symbol of any kind, which is often a
   * variable declaration. Reports want the function around it, so this walks
   * up until it finds one.
   */
  enclosingOfKind(id: SymbolId, kinds: ReadonlySet<SymbolKind>): SymbolRecord | undefined {
    let current = this.symbol(id);
    let hops = 0;
    while (current && hops++ < 64) {
      if (kinds.has(current.kind)) return current;
      current = current.parent ? this.symbol(current.parent) : undefined;
    }
    return undefined;
  }

  /**
   * Modules that reach `target` by following imports, up to `maxDepth` hops.
   *
   * Used to decide whether two branches' changes can meet at all. A change in
   * a module nothing imports, transitively, cannot interact with a change
   * somewhere else however suggestive the two look.
   */
  modulesReaching(target: ModulePath, maxDepth = 8): Map<ModulePath, number> {
    const distances = new Map<ModulePath, number>([[target, 0]]);
    let frontier: ModulePath[] = [target];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: ModulePath[] = [];
      for (const module of frontier) {
        for (const edge of this.importersOf(module)) {
          if (distances.has(edge.from)) continue;
          distances.set(edge.from, depth);
          next.push(edge.from);
        }
      }
      frontier = next;
    }
    return distances;
  }

  /** Every symbol, for iteration by analyzers. */
  symbols(): IterableIterator<SymbolRecord> {
    return this.index.symbols.values();
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
