import type { LanguageId } from '../core/model/ids.ts';
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
