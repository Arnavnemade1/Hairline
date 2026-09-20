import ts from 'typescript';
import {
  makeModuleId,
  makeSymbolId,
  type ModulePath,
  type SymbolId,
  type SymbolKind,
} from '../../core/model/ids.ts';
import type { SourceRange } from '../../core/model/source.ts';
import type { ExportKind, SymbolFlags, SymbolRecord } from '../../core/model/symbols.ts';
import type {
  ExportedName,
  ImportEdge,
  LiteralObservation,
  Reference,
  ReferenceKind,
} from '../../core/model/references.ts';
import type { AnalysisDiagnostic } from '../../core/model/diagnostics.ts';
import { declaredName, hasModifier, symbolKindOf } from './kinds.ts';
import { bodyHash, extractContract, typeText as typeTextOf } from './contracts.ts';
import type { SnapshotProgram } from './program.ts';

export interface ExtractionResult {
  readonly symbols: Map<SymbolId, SymbolRecord>;
  readonly references: Reference[];
  readonly imports: ImportEdge[];
  readonly exports: ExportedName[];
  readonly literals: LiteralObservation[];
  readonly diagnostics: AnalysisDiagnostic[];
  readonly resolvedReferenceCount: number;
  /** Bound by the checker to lib.d.ts or node_modules. */
  readonly externalReferenceCount: number;
  /** Bound to an in-repo declaration Hairline does not model (locals). */
  readonly localReferenceCount: number;
  readonly unresolvedReferenceCount: number;
}

/** Guards against cyclic re-export chains, which `getAliasedSymbol` will follow forever. */
const MAX_ALIAS_HOPS = 16;

/**
 * Follow an import/re-export alias to the declaration it ultimately names.
 *
 * Without this, one exported function fragments into a distinct symbol per
 * import site, and "who references this?" under-reports badly. `getAliasedSymbol`
 * throws rather than returning undefined when a symbol is not a resolvable
 * alias, so the call is guarded on both ends.
 */
function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    if ((current.flags & ts.SymbolFlags.Alias) === 0) return current;
    let next: ts.Symbol | undefined;
    try {
      next = checker.getAliasedSymbol(current);
    } catch {
      return current;
    }
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

function rangeOf(node: ts.Node, module: ModulePath): SourceRange {
  const file = node.getSourceFile();
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  return {
    module,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function exportKindOf(node: ts.Node): ExportKind {
  // A variable's `export` modifier lives on the enclosing statement.
  const carrier =
    ts.isVariableDeclaration(node) && node.parent.parent ? node.parent.parent : node;
  if (!hasModifier(carrier, ts.SyntaxKind.ExportKeyword)) return 'none';
  return hasModifier(carrier, ts.SyntaxKind.DefaultKeyword) ? 'default' : 'named';
}

function flagsOf(node: ts.Node): SymbolFlags {
  const flags: { -readonly [K in keyof SymbolFlags]: SymbolFlags[K] } = {};
  if (hasModifier(node, ts.SyntaxKind.AbstractKeyword)) flags.abstract = true;
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) flags.async = true;
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) flags.declare = true;
  if ((node as { asteriskToken?: ts.Node }).asteriskToken) flags.generator = true;
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    if ((node.parent.flags & ts.NodeFlags.Const) !== 0) flags.const = true;
  }
  return flags;
}

/**
 * Identity-and-body only, for declarations outside the contract scope.
 *
 * `typeResolved: false` is the honest marker: the type is *unknown* here, not
 * absent. Nothing downstream may read a missing facet as evidence of anything.
 */
function cheapContract(declaration: ts.Declaration): { typeResolved: false; bodyHash?: string } {
  const hash = bodyHash(declaration);
  return hash ? { typeResolved: false, bodyHash: hash } : { typeResolved: false };
}

function docSummaryOf(node: ts.Node): string | undefined {
  const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const comment = jsDoc?.[0]?.comment;
  if (typeof comment === 'string') return comment.split('\n')[0]?.trim();
  return undefined;
}

const TYPE_DECLARATION_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'interface',
  'type-alias',
]);

/**
 * How a use site depends on what it names.
 *
 * Determined from the syntactic parent rather than from the resolved symbol,
 * because the same symbol can be called in one place and passed as a value in
 * another, and a parameter change only reaches the former.
 */
function referenceKindOf(identifier: ts.Node): ReferenceKind {
  const parent = identifier.parent;
  if (!parent) return 'unknown';

  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return 'import';
  }
  if (ts.isExportSpecifier(parent)) return 'export';

  if (ts.isCallExpression(parent) && parent.expression === identifier) return 'call';
  if (ts.isNewExpression(parent) && parent.expression === identifier) return 'instantiate';

  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name === identifier) {
      const grandparent = parent.parent;
      if (ts.isCallExpression(grandparent) && grandparent.expression === parent) return 'call';
      if (
        ts.isBinaryExpression(grandparent) &&
        grandparent.left === parent &&
        grandparent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        return 'write';
      }
      return 'property-access';
    }
    return 'read';
  }

  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return 'type';
  if (ts.isExpressionWithTypeArguments(parent)) {
    const clause = parent.parent;
    if (ts.isHeritageClause(clause)) {
      return clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
    }
    return 'type';
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === identifier &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return 'write';
  }

  return 'read';
}

/** `true` for the identifier that *is* a declaration's name, rather than a use of it. */
function isDeclarationName(identifier: ts.Node): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  const named = parent as { name?: ts.Node };
  return named.name === identifier && symbolKindOf(parent) !== undefined;
}

function literalValueOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  if (ts.isNumericLiteral(node)) return JSON.stringify(Number(node.text));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return JSON.stringify(-Number(node.operand.text));
  }
  return undefined;
}

const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);

/**
 * Whether a call's result is treated as a promise at the call site.
 *
 * Deliberately conservative: it recognises the forms where the intent is
 * unambiguous and answers `false` otherwise. A false negative here makes an
 * analyzer report something a human then dismisses; a false positive would
 * make it stay quiet about a real break, which is the worse error.
 */
function consumesAsPromise(call: ts.Node): boolean {
  const parent = call.parent;
  if (!parent) return false;
  if (ts.isAwaitExpression(parent)) return true;
  // `f().then(...)` — the call is the object of a promise method.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === call) {
    return PROMISE_METHODS.has(parent.name.text);
  }
  // `return f()` from an async function, or `yield f()`.
  if (ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) {
    let enclosing: ts.Node | undefined = parent;
    while (enclosing && !ts.isFunctionLike(enclosing)) enclosing = enclosing.parent;
    return enclosing !== undefined && hasModifier(enclosing, ts.SyntaxKind.AsyncKeyword);
  }
  // An arrow body: `const go = async () => f()`.
  if (ts.isArrowFunction(parent) && parent.body === call) {
    return hasModifier(parent, ts.SyntaxKind.AsyncKeyword);
  }
  // `Promise.all([f(), g()])` and friends.
  if (ts.isArrayLiteralExpression(parent) && parent.parent && ts.isCallExpression(parent.parent)) {
    const callee = parent.parent.expression;
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      ? callee.expression.text === 'Promise'
      : false;
  }
  return false;
}

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Walks one snapshot's program and produces everything the engine needs.
 *
 * Two passes. The first names every declaration, which is what makes the
 * second pass able to say *which* symbol a use site refers to; a single pass
 * cannot, because a file may reference a declaration that appears later.
 */
/** Default wall-clock budget for contract extraction. */
export const DEFAULT_CONTRACT_BUDGET_MS = 20_000;

/** Declarations between budget checks; `Date.now()` per declaration is itself a cost. */
const BUDGET_CHECK_INTERVAL = 64;

export function extract(
  snapshotProgram: SnapshotProgram,
  contractScope?: ReadonlySet<ModulePath>,
  contractBudgetMs: number = DEFAULT_CONTRACT_BUDGET_MS,
): ExtractionResult {
  const { checker, sourceFiles, fromVirtual } = snapshotProgram;

  /**
   * Widen a caller's scope by one import hop.
   *
   * A symbol's contract can move because a type it *imports* moved —
   * `User.status` changes when `Status` does, without `user.ts` being edited.
   * Including the direct importers of every in-scope module catches that,
   * which is the case that matters in practice, while still leaving the
   * overwhelming majority of an unchanged repository untouched. Derivations
   * further than one hop are attributed to the symbol that actually changed
   * rather than to each symbol downstream of it.
   */
  const effectiveScope: ReadonlySet<ModulePath> | undefined = (() => {
    if (!contractScope) return undefined;
    const widened = new Set(contractScope);
    for (const file of sourceFiles) {
      const module = fromVirtual(file.fileName);
      if (module === undefined || widened.has(module)) continue;
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const resolved = checker
          .getSymbolAtLocation(specifier)
          ?.declarations?.find(ts.isSourceFile);
        const target = resolved ? fromVirtual(resolved.fileName) : undefined;
        if (target !== undefined && contractScope.has(target)) {
          widened.add(module);
          break;
        }
      }
    }
    return widened;
  })();

  const inScope = (module: ModulePath): boolean =>
    effectiveScope === undefined || effectiveScope.has(module);

  const budgetStart = Date.now();
  let examined = 0;
  let budgetSpent = false;
  let skippedForBudget = 0;

  /**
   * Whether there is still time to compute a full contract.
   *
   * Checked in batches rather than per declaration, and latched once spent so
   * the clock is not consulted again.
   */
  const withinBudget = (): boolean => {
    if (budgetSpent) return false;
    if (contractBudgetMs <= 0) return true;
    if (++examined % BUDGET_CHECK_INTERVAL !== 0) return true;
    if (Date.now() - budgetStart < contractBudgetMs) return true;
    budgetSpent = true;
    return false;
  };

  const symbols = new Map<SymbolId, SymbolRecord>();
  const references: Reference[] = [];
  const imports: ImportEdge[] = [];
  const exports: ExportedName[] = [];
  const literals: LiteralObservation[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  /** ts.Declaration -> the identity we minted for it. */
  const declarationIds = new Map<ts.Node, SymbolId>();
  let resolvedReferenceCount = 0;
  let externalReferenceCount = 0;
  let localReferenceCount = 0;
  let unresolvedReferenceCount = 0;

  // ---------------------------------------------------------------- pass 1
  for (const file of sourceFiles) {
    const module = fromVirtual(file.fileName);
    if (module === undefined) continue;

    const moduleId = makeModuleId('ts', module);
    symbols.set(moduleId, {
      id: moduleId,
      kind: 'module',
      name: module,
      module,
      exported: 'named',
      contract: { typeResolved: false },
      flags: {},
      range: { module, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    });

    /** Counts declarations sharing a path+kind, so overloads get distinct ids. */
    const seen = new Map<string, number>();

    const visit = (node: ts.Node, path: readonly string[], parent: SymbolId | undefined): void => {
      const kind = symbolKindOf(node);
      const name = kind ? declaredName(node) : undefined;

      if (kind && name !== undefined) {
        const nextPath = [...path, name];
        const key = `${nextPath.join('.')}@${kind}`;
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);

        const id = makeSymbolId({
          language: 'ts',
          module,
          path: nextPath,
          kind,
          ...(index > 0 ? { disambiguator: index } : {}),
        });
        declarationIds.set(node, id);

        const location = (node as { name?: ts.Node }).name ?? node;
        // Outside the scope, a cheap contract: enough to notice that nothing
        // changed, without paying the checker for detail nobody will read.
        const affordable = inScope(module) && withinBudget();
        if (inScope(module) && !affordable) skippedForBudget++;
        const contract = affordable
          ? extractContract({
              checker,
              declaration: node as ts.Declaration,
              location,
              isTypeDeclaration: TYPE_DECLARATION_KINDS.has(kind),
            })
          : cheapContract(node as ts.Declaration);

        if (affordable && !contract.typeResolved && kind !== 'module') {
          diagnostics.push({
            code: 'type-unavailable',
            severity: 'info',
            message: `No usable type for \`${nextPath.join('.')}\`; contract comparison for it is limited to syntax`,
            module,
            range: rangeOf(node, module),
          });
        }

        const doc = docSummaryOf(node);
        symbols.set(id, {
          id,
          kind,
          name,
          module,
          exported: exportKindOf(node),
          contract,
          flags: flagsOf(node),
          range: rangeOf(node, module),
          ...(parent ? { parent } : {}),
          ...(doc ? { docSummary: doc } : {}),
        });

        ts.forEachChild(node, (child) => visit(child, nextPath, id));
        return;
      }

      // A named declaration we deliberately do not model (computed names,
      // destructuring patterns). Recorded so the gap is visible.
      if (kind && name === undefined) {
        diagnostics.push({
          code: 'unsupported-construct',
          severity: 'info',
          message: `Declaration with a computed or destructured name is not tracked as a symbol`,
          module,
          range: rangeOf(node, module),
        });
      }

      ts.forEachChild(node, (child) => visit(child, path, parent));
    };

    ts.forEachChild(file, (child) => visit(child, [], moduleId));
  }

  // ---------------------------------------------------------------- pass 2
  /**
   * Map a checker symbol onto the identity we minted for its declaration.
   *
   * Deliberately strict: it never walks up to an enclosing declaration. Doing
   * so would make a use of a parameter resolve to its function, so every
   * function that read its own arguments would appear to reference itself and
   * would pollute every "who depends on this?" query.
   */
  const idForSymbol = (symbol: ts.Symbol): SymbolId | undefined => {
    const target = unalias(checker, symbol);
    for (const declaration of target.declarations ?? []) {
      const id = declarationIds.get(declaration);
      if (id) return id;
    }
    return undefined;
  };

  const snapshotFiles = new Set(sourceFiles);

  /**
   * Why a reference did not get an in-repo identity.
   *
   * `array.push(x)` and `import ts from 'typescript'` bind perfectly well —
   * their declarations simply live outside the snapshot, where no branch can
   * change them. Calling that "unresolved" would make every healthy
   * repository look substantially unanalysed. Only a reference that binds to
   * nothing at all is a gap in what Hairline can see.
   */
  const classify = (symbol: ts.Symbol | undefined): 'external' | 'local' | 'unresolved' => {
    if (!symbol) return 'unresolved';
    const target = unalias(checker, symbol);
    const declarations = target.declarations ?? [];
    if (declarations.length === 0) return 'unresolved';
    return declarations.some((d) => snapshotFiles.has(d.getSourceFile())) ? 'local' : 'external';
  };

  /**
   * Resolve a key in an object literal to the declared member it is filling in.
   *
   * `{ status: 'active' }` assigned to a `User` is a use of `User.status`.
   * Without this the write side of a structural contract is invisible: only
   * readers of `user.status` would be linked to the property.
   */
  const contextualMemberId = (name: ts.Node): SymbolId | undefined => {
    const assignment = name.parent;
    if (!assignment) return undefined;
    if (!ts.isPropertyAssignment(assignment) && !ts.isShorthandPropertyAssignment(assignment)) {
      return undefined;
    }
    const literal = assignment.parent;
    if (!ts.isObjectLiteralExpression(literal)) return undefined;
    let contextual: ts.Type | undefined;
    try {
      contextual = checker.getContextualType(literal);
    } catch {
      return undefined;
    }
    if (!contextual) return undefined;
    const key = declaredName(assignment);
    if (key === undefined) return undefined;

    // `getProperty` on a union only answers for properties present on every
    // constituent, so `User | null` yields nothing. A returned-or-null object
    // is an extremely common shape, so each constituent is tried in turn.
    const candidates = contextual.isUnion() ? contextual.types : [contextual];
    for (const candidate of candidates) {
      const property = candidate.getProperty(key);
      if (!property) continue;
      const id = idForSymbol(property);
      if (id) return id;
    }
    return undefined;
  };

  /**
   * Ask the checker what a module actually exports.
   *
   * Going through `getExportsOfModule` rather than reading `export` statements
   * means `export * from './x'` is expanded, re-exports are followed to their
   * declaration, and renames (`export { a as b }`) are reported under the name
   * importers must use — none of which is visible syntactically.
   */
  const collectExports = (file: ts.SourceFile, module: ModulePath): void => {
    const moduleSymbol = checker.getSymbolAtLocation(file);
    if (!moduleSymbol) return;
    let exported: ts.Symbol[];
    try {
      exported = checker.getExportsOfModule(moduleSymbol);
    } catch {
      return;
    }
    const declaredHere = new Set<string>();
    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) declaredHere.add(element.name.text);
      }
    }

    for (const symbol of exported) {
      const name = symbol.getName();
      const target = idForSymbol(symbol);
      const declaration = symbol.declarations?.[0];
      const range =
        declaration && declaration.getSourceFile() === file
          ? rangeOf(declaration, module)
          : { module, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };

      // An alias symbol carries `Alias` flags, not the flags of what it names,
      // so a re-exported value would be mislabelled type-only unless the alias
      // is resolved first.
      const resolved = unalias(checker, symbol);
      let typeText: string | undefined;
      const typeSite = resolved.valueDeclaration ?? resolved.declarations?.[0];
      if (typeSite) {
        try {
          typeText = typeTextOf(checker, checker.getTypeAtLocation(typeSite));
        } catch {
          typeText = undefined;
        }
      }

      exports.push({
        module,
        name,
        typeOnly: (resolved.flags & ts.SymbolFlags.Value) === 0,
        // A name that no `export {}` clause in this file mentions, and whose
        // declaration lives elsewhere, arrived through `export *`.
        viaStar:
          !declaredHere.has(name) &&
          declaration !== undefined &&
          declaration.getSourceFile() !== file,
        range,
        ...(target ? { target } : {}),
        ...(typeText !== undefined ? { typeText } : {}),
      });
    }
  };

  for (const file of sourceFiles) {
    const module = fromVirtual(file.fileName);
    if (module === undefined) continue;
    const moduleId = makeModuleId('ts', module);
    collectExports(file, module);

    /** Nearest enclosing declaration we gave an identity to. */
    const enclosingId = (node: ts.Node): SymbolId => {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        const id = declarationIds.get(current);
        if (id) return id;
        current = current.parent;
      }
      return moduleId;
    };

    const recordLiteral = (
      node: ts.Node,
      value: string,
      constrainedBy: ts.Node | undefined,
      context: LiteralObservation['context'],
    ): void => {
      const observation: {
        -readonly [K in keyof LiteralObservation]: LiteralObservation[K];
      } = {
        enclosing: enclosingId(node),
        range: rangeOf(node, module),
        value,
        context,
      };

      if (constrainedBy) {
        observation.againstName = constrainedBy.getText().slice(0, 120);
        let type: ts.Type | undefined;
        try {
          type = checker.getTypeAtLocation(constrainedBy);
        } catch {
          type = undefined;
        }
        if (type) {
          observation.siteTypeText = typeTextOf(checker, type);
          // The named type that constrains this position, if it has one. For
          // `user.status === 'disabled'` this is the `Status` alias — the
          // handle that ties the observation to whoever changed that type.
          const aliasSymbol = type.aliasSymbol ?? type.getSymbol();
          if (aliasSymbol) {
            const typeId = idForSymbol(aliasSymbol);
            if (typeId) observation.against = typeId;
          }
        }
        const valueSymbol = checker.getSymbolAtLocation(constrainedBy);
        if (valueSymbol) {
          const viaId = idForSymbol(valueSymbol);
          if (viaId) observation.viaSymbol = viaId;
        }
      }

      literals.push(observation);
    };

    const visit = (node: ts.Node): void => {
      // ---- imports and re-exports
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifierNode = node.moduleSpecifier;
        if (specifierNode && ts.isStringLiteral(specifierNode)) {
          const specifier = specifierNode.text;
          const names: string[] = [];
          let namespaceImport = false;
          let typeOnly = false;

          if (ts.isImportDeclaration(node)) {
            typeOnly = node.importClause?.isTypeOnly ?? false;
            const bindings = node.importClause?.namedBindings;
            if (node.importClause?.name) names.push(node.importClause.name.text);
            if (bindings) {
              if (ts.isNamespaceImport(bindings)) namespaceImport = true;
              else for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
            }
          } else {
            typeOnly = node.isTypeOnly;
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const element of node.exportClause.elements) {
                names.push((element.propertyName ?? element.name).text);
              }
            } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
              namespaceImport = true;
            }
          }

          // Ask the checker where the specifier actually landed, rather than
          // re-implementing module resolution.
          const resolvedSymbol = checker.getSymbolAtLocation(specifierNode);
          const resolvedFile = resolvedSymbol?.declarations?.find(ts.isSourceFile);
          const resolvedPath = resolvedFile ? fromVirtual(resolvedFile.fileName) : undefined;

          imports.push({
            from: module,
            specifier,
            range: rangeOf(node, module),
            names,
            namespaceImport,
            typeOnly,
            dynamic: false,
            ...(resolvedPath !== undefined ? { to: resolvedPath } : {}),
          });

          if (resolvedPath === undefined && specifier.startsWith('.')) {
            diagnostics.push({
              code: 'unresolved-import',
              severity: 'warning',
              message: `Relative import \`${specifier}\` did not resolve inside this snapshot`,
              module,
              range: rangeOf(node, module),
            });
          }
        }
      }

      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) {
          imports.push({
            from: module,
            specifier: argument.text,
            range: rangeOf(node, module),
            names: [],
            namespaceImport: true,
            typeOnly: false,
            dynamic: true,
          });
          diagnostics.push({
            code: 'unsupported-construct',
            severity: 'info',
            message: `Dynamic import of \`${argument.text}\`; its consumers are not tracked`,
            module,
            range: rangeOf(node, module),
          });
        }
      }

      // ---- literal observations
      if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
        const leftValue = literalValueOf(node.left);
        const rightValue = literalValueOf(node.right);
        if (rightValue !== undefined && leftValue === undefined) {
          recordLiteral(node.right, rightValue, node.left, 'equality');
        } else if (leftValue !== undefined && rightValue === undefined) {
          recordLiteral(node.left, leftValue, node.right, 'equality');
        }
      }

      if (ts.isCaseClause(node)) {
        const value = literalValueOf(node.expression);
        if (value !== undefined) {
          const switchStatement = node.parent.parent;
          const subject = ts.isSwitchStatement(switchStatement)
            ? switchStatement.expression
            : undefined;
          recordLiteral(node.expression, value, subject, 'switch-case');
        }
      }

      if (ts.isElementAccessExpression(node)) {
        const value = literalValueOf(node.argumentExpression);
        if (value !== undefined) {
          recordLiteral(node.argumentExpression, value, node.expression, 'property-access');
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'includes' || node.expression.name.text === 'indexOf')
      ) {
        const argument = node.arguments[0];
        const value = argument ? literalValueOf(argument) : undefined;
        if (value !== undefined && argument) {
          recordLiteral(argument, value, node.expression.expression, 'array-membership');
        }
      }

      if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
        const key = declaredName(node);
        // Only interesting when the object is a lookup table keyed by a
        // literal union — `Record<Status, string>` and friends. Recording every
        // object-literal key would bury the signal in noise, so the contextual
        // type must actually be a mapped type before a key counts.
        if (key !== undefined && ts.isObjectLiteralExpression(node.parent)) {
          let contextual: ts.Type | undefined;
          try {
            contextual = checker.getContextualType(node.parent);
          } catch {
            contextual = undefined;
          }
          const objectFlags = contextual
            ? ((contextual as ts.ObjectType).objectFlags ?? 0)
            : 0;
          if (contextual && (objectFlags & ts.ObjectFlags.Mapped) !== 0) {
            recordLiteral(node.name, JSON.stringify(key), node.parent, 'object-key');
          }
        }
      }

      if (ts.isLiteralTypeNode(node)) {
        const value = literalValueOf(node.literal);
        if (value !== undefined) {
          literals.push({
            enclosing: enclosingId(node),
            range: rangeOf(node, module),
            value,
            context: 'literal-type',
          });
        }
      }

      // ---- references
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        const kind = referenceKindOf(node);
        let symbol: ts.Symbol | undefined;
        try {
          symbol = checker.getSymbolAtLocation(node);
        } catch {
          symbol = undefined;
        }
        const targetId =
          (symbol ? idForSymbol(symbol) : undefined) ?? contextualMemberId(node);

        if (targetId) {
          resolvedReferenceCount++;
        } else {
          switch (classify(symbol)) {
            case 'external':
              externalReferenceCount++;
              break;
            case 'local':
              localReferenceCount++;
              break;
            case 'unresolved':
              unresolvedReferenceCount++;
              break;
          }
        }

        const reference: { -readonly [K in keyof Reference]: Reference[K] } = {
          from: enclosingId(node),
          kind,
          range: rangeOf(node, module),
          name: node.text,
        };
        if (targetId) reference.to = targetId;

        if (kind === 'call' || kind === 'instantiate') {
          const call = ts.isCallExpression(node.parent)
            ? node.parent
            : ts.isNewExpression(node.parent)
              ? node.parent
              : ts.isPropertyAccessExpression(node.parent) &&
                  (ts.isCallExpression(node.parent.parent) || ts.isNewExpression(node.parent.parent))
                ? (node.parent.parent as ts.CallExpression | ts.NewExpression)
                : undefined;
          if (call) {
            const args = call.arguments ?? [];
            reference.argumentCount = args.length;
            if (args.some((a) => ts.isSpreadElement(a))) reference.spreadArguments = true;
            if (kind === 'call') reference.awaited = consumesAsPromise(call);
          }
        }

        references.push(reference);
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(file, visit);
  }

  if (skippedForBudget > 0) {
    diagnostics.push({
      code: 'limit-exceeded',
      severity: 'error',
      message:
        `Contract extraction exceeded its ${contractBudgetMs}ms budget; ${skippedForBudget} symbol(s) ` +
        `were indexed by identity only. Contract comparisons involving them are incomplete — ` +
        `re-run with a larger budget to analyse them.`,
    });
  }

  return {
    symbols,
    references,
    imports,
    exports,
    literals,
    diagnostics,
    resolvedReferenceCount,
    externalReferenceCount,
    localReferenceCount,
    unresolvedReferenceCount,
  };
}
