import ts from 'typescript';
import type { SymbolKind } from '../../core/model/ids.ts';

/** Declarations that get their own identity in the index. */
export function symbolKindOf(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type-alias';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isEnumMember(node)) return 'enum-member';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  if (ts.isVariableDeclaration(node)) return 'variable';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property';
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'accessor';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  // Parameters are indexed so that a use of a parameter resolves to the
  // parameter rather than falling through to its enclosing function, which
  // would make every function appear to reference itself.
  if (ts.isParameter(node)) return 'parameter';
  return undefined;
}

/**
 * The declared name, when it is a name we can reason about.
 *
 * Computed names (`[Symbol.iterator]`, `[key]`) are deliberately excluded:
 * an identity built from an expression that may evaluate differently on two
 * branches would be an identity that silently changes meaning.
 */
export function declaredName(node: ts.Node): string | undefined {
  const named = node as { name?: ts.Node };
  const name = named.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
    return undefined;
  }
  return undefined;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

export function visibilityOf(node: ts.Node): 'public' | 'protected' | 'private' {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  const named = (node as { name?: ts.Node }).name;
  if (named && ts.isPrivateIdentifier(named)) return 'private';
  return 'public';
}

/**
 * Fingerprint of a node's structure, ignoring comments, whitespace and
 * formatting entirely.
 *
 * Built from the token stream rather than the source text so that a reformat,
 * a moved brace, or a changed comment cannot register as a change. Identifier
 * and literal text *is* included, because renaming a local variable is not
 * interesting but calling a different function is.
 */
export function structuralTokens(node: ts.Node): string[] {
  const tokens: string[] = [];
  const visit = (current: ts.Node): void => {
    // Parentheses carry no meaning of their own; `return a + b` and
    // `return (a + b)` are the same program. Emitting a token for them would
    // make a reformat register as an implementation change.
    if (ts.isParenthesizedExpression(current) || ts.isParenthesizedTypeNode(current)) {
      ts.forEachChild(current, visit);
      return;
    }
    tokens.push(String(current.kind));
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) {
      tokens.push(current.text);
    } else if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current)) {
      tokens.push(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return tokens;
}
