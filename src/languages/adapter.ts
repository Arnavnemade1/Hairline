import type { LanguageId, ModulePath } from '../core/model/ids.ts';
import type { RepositorySnapshot, SemanticIndex } from '../core/model/snapshot.ts';

/**
 * What an adapter can actually tell the engine.
 *
 * Capabilities are declared rather than assumed so that analyzers can ask
 * "do I have type information here?" instead of inferring it from absence,
 * and so that findings can say which analyses were possible. A language whose
 * adapter cannot resolve types is not the same as a language with no type
 * conflicts.
 */
export interface AdapterCapabilities {
  /** Produces a syntax tree for its files. */
  readonly parse: boolean;
  /** Names declarations and gives them stable identities. */
  readonly symbols: boolean;
  /** Binds identifiers to the declarations they refer to, across files. */
  readonly references: boolean;
  /** Supplies types from a checker, not just syntax. */
  readonly types: boolean;
  /** Models call signatures precisely enough to compare arity and parameters. */
  readonly signatures: boolean;
  /** Extracts the admissible literal values of a type. */
  readonly literalSets: boolean;
  /** Models module imports and exports. */
  readonly modules: boolean;
}

export interface IndexOptions {
  /**
   * Modules whose symbols need full contracts.
   *
   * Extracting a contract means asking the checker to render types, list
   * members and resolve signatures, and on a real repository that is where
   * essentially all the indexing time goes. A real merge pair touches around
   * 1% of files, so computing full contracts for the other 99% is wasted:
   * those symbols are byte-identical on both sides and will compare equal
   * whatever detail is recorded.
   *
   * Symbols outside the scope still get identity, export status and a body
   * fingerprint — enough for the differ to see that nothing changed — but not
   * the expensive facets. Omit to compute everything, which is what the unit
   * tests do.
   */
  readonly contractScope?: ReadonlySet<ModulePath>;
  /**
   * Wall-clock budget for contract extraction, in milliseconds.
   *
   * Rendering a type can be arbitrarily expensive: a sufficiently recursive
   * conditional type will keep the checker busy for minutes on a single
   * declaration, and real repositories contain them. A tool that sometimes
   * takes a quarter of an hour cannot be a pre-merge gate, so extraction stops
   * paying for detail once the budget is spent and says so in a diagnostic.
   * Symbols after that point keep identity and a body fingerprint, exactly as
   * out-of-scope symbols do.
   *
   * Zero or negative disables the budget.
   */
  readonly contractBudgetMs?: number;
  /**
   * Directory whose `node_modules` may be read for dependency type
   * declarations. Opt-in; absent means dependency types are unavailable and
   * the adapter says so in its diagnostics.
   */
  readonly nodeModulesRoot?: string;
}

/**
 * The seam between the language-agnostic engine and one language's tooling.
 *
 * Everything downstream — graph, change model, analyzers, reporters — is
 * written against `SemanticIndex` and never against TypeScript. Adding a
 * language means implementing this interface, declaring honest capabilities,
 * and adding fixtures; it does not mean touching the engine.
 */
export interface LanguageAdapter {
  readonly id: LanguageId;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  index(snapshot: RepositorySnapshot, options?: IndexOptions): SemanticIndex;
}

export class AdapterRegistry {
  readonly #adapters = new Map<LanguageId, LanguageAdapter>();

  register(adapter: LanguageAdapter): this {
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: LanguageId): LanguageAdapter | undefined {
    return this.#adapters.get(id);
  }

  list(): LanguageAdapter[] {
    return [...this.#adapters.values()];
  }
}
