import type { ModulePath, SymbolId } from './ids.ts';
import type { SourceRange } from './source.ts';

/**
 * How one piece of code depends on another.
 *
 * The kind matters for analysis, not just for display: removing a parameter
 * breaks `call` references but not `type` references, and removing an export
 * breaks `import` references regardless of how the imported value is used.
 */
export type ReferenceKind =
  | 'call'
  | 'instantiate'
  | 'read'
  | 'write'
  | 'type'
  | 'import'
  | 'export'
  | 'extends'
  | 'implements'
  | 'property-access'
  | 'unknown';

export interface Reference {
  /** The enclosing symbol containing the use site (the module, if top level). */
  readonly from: SymbolId;
  /** Resolved target. Absent when resolution failed. */
  readonly to?: SymbolId;
  readonly kind: ReferenceKind;
  readonly range: SourceRange;
  /**
   * Textual target, always populated. For unresolved references this is the
   * only handle analyzers have, and it is deliberately preserved rather than
   * dropping the reference — a dropped reference silently becomes
   * "nothing depends on this".
   */
  readonly name: string;
  /**
   * For call references: how many arguments the call site passes. Lets the
   * signature analyzer decide whether a parameter change actually reaches
   * this caller.
   */
  readonly argumentCount?: number;
  /** For call references: `true` when the call spreads an array argument. */
  readonly spreadArguments?: boolean;
  /**
   * For call references: whether the result is consumed as a promise —
   * `await f()`, `f().then(...)`, or `return f()` from an async function.
   *
   * This is what makes a synchronous-to-asynchronous change decidable rather
   * than merely suspicious: a new call site that uses the result directly
   * receives a Promise where it expects a value, while one that already awaits
   * is unaffected. Absent when the reference is not a call.
   */
  readonly awaited?: boolean;
}

/** A module-to-module edge, independent of which symbols crossed it. */
export interface ImportEdge {
  readonly from: ModulePath;
  /** Specifier exactly as written. */
  readonly specifier: string;
  /** Resolved module, when resolution succeeded. */
  readonly to?: ModulePath;
  readonly range: SourceRange;
  /** Imported names; empty for side-effect and namespace imports. */
  readonly names: readonly string[];
  readonly namespaceImport: boolean;
  readonly typeOnly: boolean;
  /** `import()` / `require()` rather than a static import. */
  readonly dynamic: boolean;
}

/**
 * One name a module makes available to importers.
 *
 * Modelled separately from the symbols a module *declares*, because the two
 * come apart constantly in TypeScript. A barrel file declares nothing and
 * exports everything; narrowing `export { a, b }` to `export { b }` removes
 * `a` from the package's public surface while `a` itself is untouched. Only
 * a view of the surface catches that.
 */
export interface ExportedName {
  /** The module doing the exporting. */
  readonly module: ModulePath;
  /** The name as importers must spell it. */
  readonly name: string;
  /** The declaration it ultimately resolves to, when that is in this repository. */
  readonly target?: SymbolId;
  /** Rendered type of the exported value, when available. */
  readonly typeText?: string;
  readonly typeOnly: boolean;
  /** True when the name arrives via `export * from`, rather than being named. */
  readonly viaStar: boolean;
  readonly range: SourceRange;
}

/**
 * A place where source code compares against, switches on, or otherwise names
 * a concrete literal value.
 *
 * This is how Hairline reasons about value-level contracts that the type
 * system either cannot see or has already widened away — `status === 'disabled'`
 * where `status` is a plain `string`, a `case 'disabled':` in untyped code, or
 * an object key in a lookup table. Removing `'disabled'` from a union upstream
 * leaves these sites silently dead.
 */
export interface LiteralObservation {
  readonly enclosing: SymbolId;
  readonly range: SourceRange;
  /** JSON-encoded literal, matching `LiteralSet.values`. */
  readonly value: string;
  /**
   * The *type* constraining this position, when it resolves to a named
   * declaration — `Status` for `user.status === 'disabled'`. This is the
   * handle that links the observation to the branch that changed the type.
   */
  readonly against?: SymbolId;
  /**
   * The value whose type that is — `User.status` in the example above.
   * Present independently of `against`, since a property can resolve when its
   * type does not.
   */
  readonly viaSymbol?: SymbolId;
  /** Textual handle for the constrained position, e.g. `user.status`. */
  readonly againstName?: string;
  /**
   * How the checker typed the position. `string` here means the type system
   * has widened the value away, so the type checker cannot see a mismatch at
   * this site even in principle — which is precisely when this observation
   * carries information nothing else has.
   */
  readonly siteTypeText?: string;
  readonly context:
    | 'equality'
    | 'switch-case'
    | 'object-key'
    | 'property-access'
    | 'array-membership'
    | 'assignment'
    | 'literal-type';
}
