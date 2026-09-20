import ts from 'typescript';
import { createHash } from 'node:crypto';
import type {
  CallableShape,
  Contract,
  LiteralSet,
  MemberShape,
  ObjectShape,
  ParameterShape,
} from '../../core/model/contracts.ts';
import { hasModifier, structuralTokens, visibilityOf } from './kinds.ts';

/**
 * `typeToString` truncates long types with an ellipsis by default. Two
 * genuinely different types can then render identically, which would make a
 * real contract change invisible. Truncation is therefore always disabled.
 */
const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

/**
 * `UseFullyQualifiedType` makes the checker disambiguate same-named types from
 * different modules, which Hairline needs — otherwise `Status` from two
 * modules compare equal. It renders them as `import("/__hairline__/src/user").Status`,
 * so the synthetic root is stripped back out: the module path is signal, the
 * mount point is not.
 */
const VIRTUAL_IMPORT = /import\("\/__hairline__\/([^"]*)"\)/g;

export function typeText(checker: ts.TypeChecker, type: ts.Type): string {
  try {
    return checker.typeToString(type, undefined, TYPE_FORMAT).replace(VIRTUAL_IMPORT, 'import("$1")');
  } catch {
    return '<unprintable>';
  }
}

function isUninformativeType(checker: ts.TypeChecker, type: ts.Type): boolean {
  return typeText(checker, type) === 'error' || (type.flags & ts.TypeFlags.Any) !== 0;
}

/**
 * The set of literal values a type admits.
 *
 * This is what makes "the union lost a member" a first-class observation
 * rather than an opaque change of type text. `open` records whether the type
 * also admits non-literal values: an open type cannot be used to argue that
 * any particular value has become impossible, and analyzers must respect that.
 */
export function literalsOfType(checker: ts.TypeChecker, type: ts.Type): LiteralSet | undefined {
  const constituents = type.isUnion() ? type.types : [type];
  const values = new Set<string>();
  let open = false;
  let sawLiteral = false;

  for (const constituent of constituents) {
    if (constituent.isStringLiteral()) {
      values.add(JSON.stringify(constituent.value));
      sawLiteral = true;
    } else if (constituent.isNumberLiteral()) {
      values.add(JSON.stringify(constituent.value));
      sawLiteral = true;
    } else if (constituent.flags & ts.TypeFlags.BooleanLiteral) {
      values.add(typeText(checker, constituent));
      sawLiteral = true;
    } else if (constituent.flags & ts.TypeFlags.EnumLiteral) {
      const value = (constituent as ts.LiteralType).value;
      values.add(value === undefined ? typeText(checker, constituent) : JSON.stringify(value));
      sawLiteral = true;
    } else if (constituent.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
      // Nullability is modelled separately; it does not make a set "open".
      values.add(typeText(checker, constituent));
    } else {
      open = true;
    }
  }

  if (!sawLiteral) return undefined;
  return { values: [...values].sort(), open };
}

export function isNullable(type: ts.Type): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents.some(
    (t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
  );
}

function normaliseExpression(node: ts.Node): string {
  return structuralTokens(node).join(' ');
}

function parameterShape(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ParameterShape {
  const name = ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText();
  const type = checker.getTypeAtLocation(parameter);
  const base = {
    name,
    typeText: typeText(checker, type),
    optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
    rest: parameter.dotDotDotToken !== undefined,
  };
  return parameter.initializer
    ? { ...base, defaultText: normaliseExpression(parameter.initializer) }
    : base;
}

function callableShapeFromSignature(
  checker: ts.TypeChecker,
  signature: ts.Signature,
): CallableShape {
  const parameters: ParameterShape[] = [];
  let requiredParameterCount = 0;
  let acceptsRest = false;

  for (const parameterSymbol of signature.getParameters()) {
    const declaration = parameterSymbol.valueDeclaration ?? parameterSymbol.declarations?.[0];
    if (declaration && ts.isParameter(declaration)) {
      const shape = parameterShape(checker, declaration);
      parameters.push(shape);
      if (!shape.optional && !shape.rest) requiredParameterCount++;
      if (shape.rest) acceptsRest = true;
    } else if (declaration) {
      const type = checker.getTypeOfSymbolAtLocation(parameterSymbol, declaration);
      parameters.push({
        name: parameterSymbol.getName(),
        typeText: typeText(checker, type),
        optional: false,
        rest: false,
      });
      requiredParameterCount++;
    }
  }

  return {
    typeParameters: (signature.getTypeParameters() ?? []).map((t) => typeText(checker, t)),
    parameters,
    returnTypeText: typeText(checker, signature.getReturnType()),
    requiredParameterCount,
    acceptsRest,
  };
}

export function callableShapes(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly CallableShape[] | undefined {
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructs = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  const all = [...calls, ...constructs];
  if (all.length === 0) return undefined;
  return all.map((s) => callableShapeFromSignature(checker, s));
}

function memberShape(checker: ts.TypeChecker, symbol: ts.Symbol, location: ts.Node): MemberShape {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration ?? location);
  const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
  const isReadonly =
    declaration !== undefined && hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword);
  const isStatic =
    declaration !== undefined && hasModifier(declaration, ts.SyntaxKind.StaticKeyword);
  const literal = literalsOfType(checker, type);
  const base: MemberShape = {
    name: stableMemberName(symbol.getName()),
    typeText: typeText(checker, type),
    optional,
    readonly: isReadonly,
    static: isStatic,
    visibility: declaration ? visibilityOf(declaration) : 'public',
  };
  // A member whose type is exactly one literal carries that value as part of
  // its contract; enum members are the canonical case.
  return literal && !literal.open && literal.values.length === 1
    ? { ...base, literalValue: literal.values[0]! }
    : base;
}

/**
 * TypeScript names well-known and unique symbol members `__@iterator@67`,
 * where the trailing number is an internal per-program symbol id. It differs
 * between two programs over identical source, so it must never reach a
 * comparison — it would report a change on every single run.
 */
const INTERNAL_SYMBOL_NAME = /^(__@[^@]+)@\d+$/;

function stableMemberName(name: string): string {
  return name.replace(INTERNAL_SYMBOL_NAME, '$1');
}

export function objectShape(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
  declaration?: ts.Node,
  extraMembers?: readonly MemberShape[],
): ObjectShape | undefined {
  // Only genuinely object-like types get a structural shape. Asking a string
  // literal union for its properties returns `String.prototype`, which is both
  // noise and a source of spurious diffs.
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;

  const properties = checker.getPropertiesOfType(type);
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexInfoOfType(type, ts.IndexKind.Number);

  // An object-like type with no members still gets a shape. Returning
  // `undefined` here would make the differ skip the comparison entirely, so a
  // type losing its last member — or gaining its first — would be invisible.

  const heritage: string[] = [];
  if (
    declaration &&
    (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
    declaration.heritageClauses
  ) {
    for (const clause of declaration.heritageClauses) {
      for (const expression of clause.types) heritage.push(expression.getText());
    }
  }

  const typeParameters: string[] = [];
  const declared = (
    declaration as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> } | undefined
  )?.typeParameters;
  if (declared) for (const parameter of declared) typeParameters.push(parameter.getText());

  return {
    members: [...(extraMembers ?? []), ...properties.map((p) => memberShape(checker, p, location))].sort(
      (a, b) => (a.static === b.static ? a.name.localeCompare(b.name) : a.static ? 1 : -1),
    ),
    heritage,
    typeParameters,
    hasIndexSignature: stringIndex !== undefined || numberIndex !== undefined,
  };
}

/**
 * Members declared on a class's constructor side.
 *
 * Returned separately and marked `static: true` so that moving a member
 * between the instance and static sides shows up as a modifier change rather
 * than as an unrelated removal plus addition.
 */
function staticSideMembers(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  location: ts.Node,
): MemberShape[] | undefined {
  if (!ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)) return undefined;
  const symbol = checker.getSymbolAtLocation(declaration.name ?? declaration);
  if (!symbol) return undefined;
  let staticType: ts.Type | undefined;
  try {
    staticType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  } catch {
    return undefined;
  }
  if (!staticType) return undefined;
  return checker
    .getPropertiesOfType(staticType)
    // `prototype` is an artefact of the constructor type, not a declared member.
    .filter((p) => p.getName() !== 'prototype')
    .map((p) => ({ ...memberShape(checker, p, location), static: true }));
}

const TOKEN_SEPARATOR = String.fromCharCode(0);

/** Hash of the implementation body, ignoring comments and formatting. */
export function bodyHash(node: ts.Node): string | undefined {
  const body = (node as { body?: ts.Node }).body;
  if (!body) return undefined;
  return createHash('sha256').update(structuralTokens(body).join(TOKEN_SEPARATOR)).digest('hex');
}

export interface ContractContext {
  readonly checker: ts.TypeChecker;
  readonly declaration: ts.Declaration;
  /** Node to ask the checker about; usually the declaration's name. */
  readonly location: ts.Node;
  /** True for interfaces, type aliases and other pure type declarations. */
  readonly isTypeDeclaration: boolean;
}

/**
 * Everything the checker can say about what a declaration promises.
 *
 * Facets that cannot be determined are omitted, and `typeResolved` records
 * whether the checker produced anything usable at all — so downstream code
 * can tell "this symbol admits no literals" from "we could not find out".
 */
export function extractContract(context: ContractContext): Contract {
  const { checker, declaration, location, isTypeDeclaration } = context;

  let type: ts.Type | undefined;
  try {
    if (isTypeDeclaration) {
      const symbol =
        checker.getSymbolAtLocation(location) ?? checker.getSymbolAtLocation(declaration);
      type = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
    } else {
      type = checker.getTypeAtLocation(location);
    }
  } catch {
    type = undefined;
  }

  const hash = bodyHash(declaration);

  if (!type) {
    return hash ? { typeResolved: false, bodyHash: hash } : { typeResolved: false };
  }

  const contract: { -readonly [K in keyof Contract]: Contract[K] } = {
    typeResolved: isTypeDeclaration || !isUninformativeType(checker, type),
    typeText: typeText(checker, type),
  };

  const callable = callableShapes(checker, type);
  if (callable) contract.callable = callable;

  // A class has two types: the instance side and the constructor side.
  // `getTypeAtLocation` gives the instance side, so static members would be
  // absent from the contract entirely — and moving a member between the two
  // would read as no change at all.
  const staticMembers = isTypeDeclaration ? undefined : staticSideMembers(checker, declaration, location);
  const object = objectShape(checker, type, location, declaration, staticMembers);
  if (object) contract.object = object;

  const literals = literalsOfType(checker, type);
  if (literals) contract.literals = literals;

  if (hash) contract.bodyHash = hash;

  const initializer = (declaration as { initializer?: ts.Expression }).initializer;
  if (initializer && !ts.isFunctionLike(initializer)) {
    contract.initializerText = normaliseExpression(initializer);
  }

  if (hasModifier(declaration, ts.SyntaxKind.DeclareKeyword)) contract.ambient = true;

  return contract;
}
