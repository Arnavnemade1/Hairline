/**
 * Stable identity for the things Hairline reasons about.
 *
 * Identity must survive edits that are not semantically interesting: line
 * movement, reformatting, and unrelated edits elsewhere in the file. It must
 * therefore never be derived from byte offsets or line numbers. Positions are
 * carried separately, as *evidence*, and are allowed to be unstable.
 *
 * The encoding is deliberately human-readable so that findings, fixtures and
 * debug output can all quote the same string:
 *
 *     ts:src/user.ts#User.status@property
 *     ts:src/api.ts#fetchUser@function
 *     ts:src/user.ts#@module
 *
 * It is inspired by SCIP's symbol descriptors but is intentionally simpler:
 * Hairline only needs identity that is stable *within one repository across
 * revisions*, not identity that is stable across packages and indexers.
 * See docs/decisions.md ADR-0004.
 */

/** Languages the engine knows how to talk about. */
export type LanguageId = 'ts';

/**
 * What kind of thing a symbol is. Kinds participate in identity because a
 * `type Foo` and a `function Foo` in the same module are different symbols
 * that happen to share a name.
 */
export type SymbolKind =
  | 'module'
  | 'function'
  | 'class'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'enum-member'
  | 'variable'
  | 'property'
  | 'method'
  | 'accessor'
  | 'parameter'
  | 'constructor'
  | 'namespace'
  | 'unknown';

/**
 * A repository-relative POSIX path identifying a source file.
 * Always forward-slashed, never absolute, never containing `..`.
 */
export type ModulePath = string;

/** The opaque, comparable form of a symbol identity. */
export type SymbolId = string & { readonly __brand: 'SymbolId' };

export interface SymbolIdParts {
  readonly language: LanguageId;
  readonly module: ModulePath;
  /**
   * Declaration nesting from the module root, e.g. `['UserService', 'getUser']`.
   * Empty for the module symbol itself.
   */
  readonly path: readonly string[];
  readonly kind: SymbolKind;
  /**
   * Disambiguates declarations that are otherwise identical, most commonly
   * overload signatures. Omitted (and absent from the encoding) when zero.
   */
  readonly disambiguator?: number;
}

const SEGMENT_ESCAPE = /[#@:\\.]/g;

function escapeSegment(segment: string): string {
  return segment.replace(SEGMENT_ESCAPE, (c) => `\\${c}`);
}

function splitEscaped(input: string, separator: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]!;
      i++;
      continue;
    }
    if (ch === separator) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Build the canonical encoded identity for a symbol. */
export function makeSymbolId(parts: SymbolIdParts): SymbolId {
  const path = parts.path.map(escapeSegment).join('.');
  const disc =
    parts.disambiguator !== undefined && parts.disambiguator !== 0
      ? `~${parts.disambiguator}`
      : '';
  return `${parts.language}:${parts.module}#${path}@${parts.kind}${disc}` as SymbolId;
}

/** Identity of the module (file) itself. */
export function makeModuleId(language: LanguageId, module: ModulePath): SymbolId {
  return makeSymbolId({ language, module, path: [], kind: 'module' });
}

/**
 * Parse an encoded identity back into its parts.
 * Returns `undefined` rather than throwing so that malformed ids read from
 * disk (caches, fixture expectations) degrade instead of crashing analysis.
 */
export function parseSymbolId(id: string): SymbolIdParts | undefined {
  const langSep = id.indexOf(':');
  if (langSep <= 0) return undefined;
  const language = id.slice(0, langSep);
  if (language !== 'ts') return undefined;

  const rest = id.slice(langSep + 1);
  const hash = rest.lastIndexOf('#');
  if (hash < 0) return undefined;
  const module = rest.slice(0, hash);

  const tail = rest.slice(hash + 1);
  const at = tail.lastIndexOf('@');
  if (at < 0) return undefined;

  const pathText = tail.slice(0, at);
  let kindText = tail.slice(at + 1);
  let disambiguator = 0;
  const tilde = kindText.lastIndexOf('~');
  if (tilde >= 0) {
    const parsed = Number(kindText.slice(tilde + 1));
    if (!Number.isInteger(parsed)) return undefined;
    disambiguator = parsed;
    kindText = kindText.slice(0, tilde);
  }

  const path = pathText === '' ? [] : splitEscaped(pathText, '.');
  return disambiguator === 0
    ? { language, module, path, kind: kindText as SymbolKind }
    : { language, module, path, kind: kindText as SymbolKind, disambiguator };
}

/** The human-facing short name, e.g. `User.status`. */
export function displayName(parts: SymbolIdParts): string {
  return parts.path.length === 0 ? parts.module : parts.path.join('.');
}

/** `User.status (src/user.ts)` — used in reports. */
export function describeSymbolId(id: SymbolId): string {
  const parts = parseSymbolId(id);
  if (!parts) return id;
  if (parts.path.length === 0) return parts.module;
  return `${parts.path.join('.')} (${parts.module})`;
}

/**
 * The identity of the symbol that lexically contains this one, if any.
 * `User.status@property` -> `User@interface` is *not* derivable (we do not know
 * the parent's kind), so the graph stores parent links explicitly. This helper
 * only answers "is `child` nested inside something in the same module".
 */
export function parentPath(parts: SymbolIdParts): readonly string[] | undefined {
  return parts.path.length > 1 ? parts.path.slice(0, -1) : undefined;
}
