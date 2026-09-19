/**
 * Contracts are the part of a symbol that *other code can depend on*.
 *
 * The distinction that makes Hairline work is between a symbol's contract and
 * its implementation. Two revisions of a function with the same contract but
 * different bodies interact with consumers very differently from two revisions
 * with different contracts — and Hairline must say which it saw, without
 * pretending it can decide whether a body change is behaviour-preserving.
 */

/** One parameter of a callable. */
export interface ParameterShape {
  readonly name: string;
  readonly typeText: string;
  readonly optional: boolean;
  readonly rest: boolean;
  /** Present when the parameter has a default; normalised source text. */
  readonly defaultText?: string;
}

/** One call signature. Overloaded symbols carry several. */
export interface CallableShape {
  readonly typeParameters: readonly string[];
  readonly parameters: readonly ParameterShape[];
  readonly returnTypeText: string;
  /** Minimum number of arguments a caller must supply. */
  readonly requiredParameterCount: number;
  readonly acceptsRest: boolean;
}

/** One member of an object-like type (interface, class, type literal, enum). */
export interface MemberShape {
  readonly name: string;
  readonly typeText: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly static: boolean;
  /** `public` unless the declaration says otherwise. */
  readonly visibility: 'public' | 'protected' | 'private';
  /** Present for enum members and literal-initialised constants. */
  readonly literalValue?: string;
}

/** The structural shape of an object-like type. */
export interface ObjectShape {
  readonly members: readonly MemberShape[];
  readonly heritage: readonly string[];
  readonly typeParameters: readonly string[];
  /** True when the type has a string/number index signature. */
  readonly hasIndexSignature: boolean;
}

/**
 * The set of literal values a type admits.
 *
 * This is the facet that lets Hairline reason about string-union and enum
 * evolution — the single most common shape of "the merge compiled and the
 * product still broke".
 */
export interface LiteralSet {
  /** JSON-encoded literal values (`"active"`, `3`, `true`), sorted. */
  readonly values: readonly string[];
  /**
   * True when the type also admits non-literal constituents (`string`,
   * a type reference, …). An open set cannot be used to argue that a value
   * has become impossible.
   */
  readonly open: boolean;
}

/**
 * Everything Hairline knows about what a symbol promises.
 *
 * Every facet is optional because adapters degrade: a JavaScript file yields
 * a `callable` with `any` types and no `literals`, and that must be
 * distinguishable from "this symbol admits no literals".
 */
export interface Contract {
  /**
   * The checker's rendering of the symbol's type. The primary comparison key
   * when it is available.
   */
  readonly typeText?: string;
  /**
   * False when type information could not be obtained. A missing `typeText`
   * with `typeResolved: false` means *unknown*, never *absent*.
   */
  readonly typeResolved: boolean;
  /** Call signatures, in declaration order. Overloads produce several. */
  readonly callable?: readonly CallableShape[];
  readonly object?: ObjectShape;
  readonly literals?: LiteralSet;
  /** Normalised initializer text, for constants whose value is part of the contract. */
  readonly initializerText?: string;
  /**
   * Fingerprint of the normalised implementation body.
   *
   * Comments, formatting and (where safely possible) local identifier
   * positions are excluded, so that a reformat does not read as a change.
   * A differing hash proves the body changed. It proves nothing about whether
   * the *behaviour* changed — see docs/architecture.md, "Body fingerprints".
   */
  readonly bodyHash?: string;
  /** Whether the declaration is `declare`/ambient, i.e. has no body by design. */
  readonly ambient?: boolean;
}

export const EMPTY_CONTRACT: Contract = { typeResolved: false };

const QUALIFIED_IMPORT = /import\("([^"]*)"\)\./g;

/**
 * Render type text for humans.
 *
 * Contracts store types fully qualified (`import("src/user").Status`) because
 * two same-named types from different modules must not compare equal. Reports
 * strip the qualification back off: the reader already has the file path in
 * the finding, and `Status` is what they wrote.
 */
export function displayTypeText(text: string): string {
  return text.replace(QUALIFIED_IMPORT, '');
}
