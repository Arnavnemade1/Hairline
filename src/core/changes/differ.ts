import { parseSymbolId, type ModulePath, type SymbolId } from '../model/ids.ts';
import type { CallableShape, Contract, LiteralSet, ObjectShape } from '../model/contracts.ts';
import type { SymbolRecord } from '../model/symbols.ts';
import type { ExportedName, ImportEdge, LiteralObservation, Reference } from '../model/references.ts';
import type { SemanticIndex } from '../model/snapshot.ts';
import type {
  BranchChangeSet,
  ContractDelta,
  RenameCandidate,
  SymbolChange,
} from './model.ts';

/**
 * Joins the parts of a composite key. A control character is used because it
 * cannot occur in a symbol id, a branch name, or a rendered type, so two
 * different keys can never collide by concatenation.
 */
const FIELD_SEPARATOR = String.fromCharCode(1);

/**
 * Nullability is modelled as its own delta rather than as part of the type
 * text, because "may now be null" reaches consumers very differently from
 * "changed from `string` to `number`" — the first breaks readers silently at
 * runtime, the second usually breaks them loudly at compile time.
 */
const NULLISH = new Set(['null', 'undefined', 'void']);

/**
 * Whether a rendered return type is something a caller must await.
 *
 * Deliberately textual rather than type-directed: the differ compares two
 * *renderings* produced by two independent programs, and there is no shared
 * checker in which to ask the question properly. The prefixes below are what
 * `typeToString` emits for the awaitable types that actually occur in return
 * position.
 */
const AWAITABLE_PREFIXES = ['Promise<', 'PromiseLike<', 'Awaited<'];

function isAwaitable(text: string): boolean {
  const trimmed = text.trim();
  return AWAITABLE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function isNullableText(text: string): boolean {
  return text
    .split('|')
    .map((part) => part.trim())
    .some((part) => NULLISH.has(part));
}

function diffLiteralSets(before: LiteralSet | undefined, after: LiteralSet | undefined): ContractDelta[] {
  // One side missing means *unknown*, never "admits nothing". Treating an
  // absent set as empty would report every value as removed the moment one
  // side's contract was not fully extracted.
  if (!before || !after) return [];
  const deltas: ContractDelta[] = [];
  const beforeValues = new Set(before?.values ?? []);
  const afterValues = new Set(after?.values ?? []);

  for (const value of beforeValues) {
    if (!afterValues.has(value)) deltas.push({ kind: 'literal-removed', value });
  }
  for (const value of afterValues) {
    if (!beforeValues.has(value)) deltas.push({ kind: 'literal-added', value });
  }
  if (before && after && before.open !== after.open) {
    deltas.push({ kind: 'literal-openness-changed', nowOpen: after.open });
  }
  return deltas;
}

function diffCallables(
  before: readonly CallableShape[] | undefined,
  after: readonly CallableShape[] | undefined,
): ContractDelta[] {
  if (!before || !after) return [];
  const deltas: ContractDelta[] = [];

  if (before.length !== after.length) {
    deltas.push({ kind: 'overload-count-changed', before: before.length, after: after.length });
  }

  // Only the first signature is compared in detail. Matching overload sets
  // across revisions is a distinct problem (which overload corresponds to
  // which?) that the MVP does not attempt; the count delta above records that
  // something moved, without inventing a pairing.
  const first = before[0];
  const second = after[0];
  if (!first || !second) return deltas;

  const beforeByName = new Map(first.parameters.map((p, i) => [p.name, { ...p, index: i }]));
  const afterByName = new Map(second.parameters.map((p, i) => [p.name, { ...p, index: i }]));

  for (const [name, parameter] of beforeByName) {
    if (!afterByName.has(name)) {
      deltas.push({
        kind: 'parameter-removed',
        name,
        index: parameter.index,
        wasRequired: !parameter.optional && !parameter.rest,
      });
    }
  }
  for (const [name, parameter] of afterByName) {
    const previous = beforeByName.get(name);
    if (!previous) {
      deltas.push({
        kind: 'parameter-added',
        name,
        index: parameter.index,
        required: !parameter.optional && !parameter.rest,
      });
      continue;
    }
    if (previous.typeText !== parameter.typeText) {
      deltas.push({
        kind: 'parameter-type-changed',
        name,
        index: parameter.index,
        before: previous.typeText,
        after: parameter.typeText,
      });
    }
    if (previous.optional !== parameter.optional) {
      deltas.push({
        kind: 'parameter-optionality-changed',
        name,
        index: parameter.index,
        nowRequired: !parameter.optional,
      });
    }
    if (previous.defaultText !== parameter.defaultText) {
      deltas.push({
        kind: 'parameter-default-changed',
        name,
        index: parameter.index,
        before: previous.defaultText,
        after: parameter.defaultText,
      });
    }
  }

  if (first.requiredParameterCount !== second.requiredParameterCount) {
    deltas.push({
      kind: 'required-arity-changed',
      before: first.requiredParameterCount,
      after: second.requiredParameterCount,
    });
  }
  if (first.returnTypeText !== second.returnTypeText) {
    deltas.push({
      kind: 'return-type-changed',
      before: first.returnTypeText,
      after: second.returnTypeText,
    });
    const wasAsync = isAwaitable(first.returnTypeText);
    const isNowAsync = isAwaitable(second.returnTypeText);
    if (wasAsync !== isNowAsync) {
      deltas.push({
        kind: 'async-boundary-changed',
        nowAsync: isNowAsync,
        before: first.returnTypeText,
        after: second.returnTypeText,
      });
    }
    const wasNullable = isNullableText(first.returnTypeText);
    const isNowNullable = isNullableText(second.returnTypeText);
    if (wasNullable !== isNowNullable) {
      deltas.push({
        kind: 'nullability-changed',
        nowNullable: isNowNullable,
        before: first.returnTypeText,
        after: second.returnTypeText,
      });
    }
  }

  return deltas;
}

function diffObjects(before: ObjectShape | undefined, after: ObjectShape | undefined): ContractDelta[] {
  if (!before || !after) return [];
  const deltas: ContractDelta[] = [];
  const beforeMembers = new Map(before.members.map((m) => [m.name, m]));
  const afterMembers = new Map(after.members.map((m) => [m.name, m]));

  const removed: string[] = [];
  const added: string[] = [];

  for (const [name, member] of beforeMembers) {
    if (!afterMembers.has(name)) removed.push(name);
    else {
      const next = afterMembers.get(name)!;
      if (member.typeText !== next.typeText) {
        deltas.push({
          kind: 'member-type-changed',
          name,
          before: member.typeText,
          after: next.typeText,
        });
      }
      if (member.optional !== next.optional) {
        deltas.push({ kind: 'member-optionality-changed', name, nowRequired: !next.optional });
      }
      // Modifiers are part of the contract even when the type is untouched:
      // narrowing visibility hides a member from every external reader,
      // `readonly` breaks writers, and moving between instance and static
      // changes how every use site must spell the access.
      if (member.visibility !== next.visibility) {
        deltas.push({
          kind: 'member-visibility-changed',
          name,
          before: member.visibility,
          after: next.visibility,
        });
      }
      if (member.readonly !== next.readonly) {
        deltas.push({ kind: 'member-readonly-changed', name, nowReadonly: next.readonly });
      }
      if (member.static !== next.static) {
        deltas.push({ kind: 'member-static-changed', name, nowStatic: next.static });
      }
    }
  }
  for (const name of afterMembers.keys()) if (!beforeMembers.has(name)) added.push(name);

  /**
   * A member that vanishes while another of the identical type appears is
   * almost always a rename. Reporting it as such gives a consumer a far more
   * actionable message than an unrelated removal plus addition — and it is
   * only claimed when exactly one candidate matches, so the inference cannot
   * silently pick the wrong pair.
   */
  const unmatchedRemovals: string[] = [];
  for (const name of removed) {
    const member = beforeMembers.get(name)!;
    const candidates = added.filter((a) => afterMembers.get(a)!.typeText === member.typeText);
    if (candidates.length === 1 && removed.filter((r) => beforeMembers.get(r)!.typeText === member.typeText).length === 1) {
      const target = candidates[0]!;
      deltas.push({ kind: 'member-renamed', before: name, after: target, typeText: member.typeText });
      added.splice(added.indexOf(target), 1);
    } else {
      unmatchedRemovals.push(name);
    }
  }

  for (const name of unmatchedRemovals) {
    deltas.push({ kind: 'member-removed', name, typeText: beforeMembers.get(name)!.typeText });
  }
  for (const name of added) {
    const member = afterMembers.get(name)!;
    deltas.push({
      kind: 'member-added',
      name,
      typeText: member.typeText,
      optional: member.optional,
    });
  }

  const beforeHeritage = [...before.heritage].sort().join(',');
  const afterHeritage = [...after.heritage].sort().join(',');
  if (beforeHeritage !== afterHeritage) {
    deltas.push({ kind: 'heritage-changed', before: before.heritage, after: after.heritage });
  }

  return deltas;
}

/**
 * Every way in which a symbol's promise moved between two revisions.
 *
 * The ordering matters for reporting: structural facts (export, kind) first,
 * then interface-shaped changes, then implementation. The body delta is last
 * because it is the weakest evidence — it proves an edit happened, not that
 * behaviour changed.
 */
export function contractDeltas(before: SymbolRecord, after: SymbolRecord): ContractDelta[] {
  const deltas: ContractDelta[] = [];

  /**
   * Whether the two contracts can be compared facet by facet at all.
   *
   * A contract may be recorded by identity alone — because its file was
   * outside the extraction scope, or because the extraction budget ran out.
   * Comparing a known contract against an unknown one would turn every facet
   * of the known side into a spurious delta, which is the single most
   * dangerous failure mode in the change model: it manufactures conflicts out
   * of an indexing shortcut. Structural facts that do not come from the
   * checker — export status, declaration kind, module, body fingerprint — are
   * still compared, because they are recorded either way.
   */
  const comparable = before.contract.typeResolved && after.contract.typeResolved;

  if (before.kind !== after.kind) {
    deltas.push({ kind: 'kind-changed', before: before.kind, after: after.kind });
  }
  if (before.exported !== after.exported) {
    if (after.exported === 'none') deltas.push({ kind: 'export-removed', before: before.exported });
    else if (before.exported === 'none') deltas.push({ kind: 'export-added', after: after.exported });
    else {
      deltas.push({ kind: 'export-kind-changed', before: before.exported, after: after.exported });
    }
  }
  if (before.module !== after.module) {
    deltas.push({ kind: 'moved', before: before.module, after: after.module });
  }

  const beforeContract: Contract = before.contract;
  const afterContract: Contract = after.contract;

  if (comparable) {
    deltas.push(...diffCallables(beforeContract.callable, afterContract.callable));
    deltas.push(...diffObjects(beforeContract.object, afterContract.object));
    deltas.push(...diffLiteralSets(beforeContract.literals, afterContract.literals));
  }

  // Only reported when nothing more specific explains the difference; an
  // unqualified "the type changed" on top of five precise deltas is noise.
  if (comparable && beforeContract.typeText !== afterContract.typeText && deltas.length === 0) {
    deltas.push({
      kind: 'type-text-changed',
      before: beforeContract.typeText ?? '<unknown>',
      after: afterContract.typeText ?? '<unknown>',
    });
    const wasNullable = isNullableText(beforeContract.typeText ?? '');
    const isNowNullable = isNullableText(afterContract.typeText ?? '');
    if (wasNullable !== isNowNullable) {
      deltas.push({
        kind: 'nullability-changed',
        nowNullable: isNowNullable,
        before: beforeContract.typeText ?? '<unknown>',
        after: afterContract.typeText ?? '<unknown>',
      });
    }
  }

  if (comparable && beforeContract.initializerText !== afterContract.initializerText) {
    deltas.push({
      kind: 'initializer-changed',
      before: beforeContract.initializerText,
      after: afterContract.initializerText,
    });
  }

  if (
    beforeContract.bodyHash !== undefined &&
    afterContract.bodyHash !== undefined &&
    beforeContract.bodyHash !== afterContract.bodyHash
  ) {
    deltas.push({
      kind: 'body-changed',
      before: beforeContract.bodyHash,
      after: afterContract.bodyHash,
    });
  }

  return deltas;
}

/**
 * Key used to pair references across revisions.
 *
 * Positions are excluded on purpose: a reference that moved down twelve lines
 * because something was inserted above it has not changed. What identifies a
 * reference is who makes it, what it names, and how.
 */
function referenceKey(reference: Reference): string {
  return `${reference.from}${FIELD_SEPARATOR}${reference.to ?? reference.name}${FIELD_SEPARATOR}${reference.kind}${FIELD_SEPARATOR}${reference.argumentCount ?? ''}${FIELD_SEPARATOR}${reference.awaited ?? ''}`;
}

function literalKey(observation: LiteralObservation): string {
  return `${observation.enclosing}${FIELD_SEPARATOR}${observation.value}${FIELD_SEPARATOR}${observation.context}${FIELD_SEPARATOR}${observation.against ?? observation.againstName ?? ''}`;
}

/**
 * Keyed by module and exported name only.
 *
 * The target is excluded deliberately: re-pointing `export { load }` at a
 * different implementation keeps the surface intact from an importer's point
 * of view, and is a `same-symbol` question rather than a surface one.
 */
function exportKey(entry: ExportedName): string {
  return `${entry.module}${FIELD_SEPARATOR}${entry.name}${FIELD_SEPARATOR}${entry.typeOnly}`;
}

function importKey(edge: ImportEdge): string {
  return `${edge.from}${FIELD_SEPARATOR}${edge.specifier}${FIELD_SEPARATOR}${[...edge.names].sort().join(',')}${FIELD_SEPARATOR}${edge.typeOnly}`;
}

function diffCollections<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
): { added: T[]; removed: T[] } {
  const beforeCounts = new Map<string, T[]>();
  for (const item of before) {
    const k = key(item);
    const bucket = beforeCounts.get(k);
    if (bucket) bucket.push(item);
    else beforeCounts.set(k, [item]);
  }

  const added: T[] = [];
  for (const item of after) {
    const k = key(item);
    const bucket = beforeCounts.get(k);
    if (bucket && bucket.length > 0) bucket.pop();
    else added.push(item);
  }

  const removed: T[] = [];
  for (const bucket of beforeCounts.values()) removed.push(...bucket);

  return { added, removed };
}

/**
 * Pair a removed symbol with an added one when the evidence for a rename is
 * strong enough to be worth saying out loud.
 *
 * The bar is deliberately high — same module, same kind, identical contract
 * shape, and no ambiguity about which pair matches. A wrong rename claim is
 * worse than no rename claim, because it redirects a reader's attention to
 * code that is fine.
 */
export function detectRenames(
  removed: readonly SymbolRecord[],
  added: readonly SymbolRecord[],
): RenameCandidate[] {
  const candidates: RenameCandidate[] = [];
  const claimed = new Set<SymbolId>();

  for (const before of removed) {
    const matches = added.filter(
      (after) =>
        !claimed.has(after.id) &&
        after.module === before.module &&
        after.kind === before.kind &&
        after.name !== before.name &&
        after.contract.typeText !== undefined &&
        after.contract.typeText === before.contract.typeText,
    );
    if (matches.length !== 1) continue;

    const after = matches[0]!;
    const competing = removed.filter(
      (other) => other !== before && other.contract.typeText === before.contract.typeText,
    );
    if (competing.length > 0) continue;

    const sameBody =
      before.contract.bodyHash !== undefined &&
      before.contract.bodyHash === after.contract.bodyHash;

    claimed.add(after.id);
    candidates.push({
      from: before.id,
      to: after.id,
      similarity: sameBody ? 1 : 0.8,
      reason: sameBody
        ? 'same module, kind, type and unchanged implementation'
        : 'same module, kind and type; implementation also changed',
    });
  }

  return candidates;
}

/**
 * Compare two indexes of the same repository and describe what one branch did.
 *
 * This is the step that turns "these files differ" into "these symbols moved,
 * in these specific ways" — the representation everything downstream needs in
 * order to say whether two branches' work can collide.
 */
export function diffIndexes(
  baseIndex: SemanticIndex,
  headIndex: SemanticIndex,
  branch: string,
  baseLabel: string,
): BranchChangeSet {
  const symbolChanges = new Map<SymbolId, SymbolChange>();
  const removedRecords: SymbolRecord[] = [];
  const addedRecords: SymbolRecord[] = [];

  for (const [id, before] of baseIndex.symbols) {
    if (parseSymbolId(id)?.kind === 'module') continue;
    const after = headIndex.symbols.get(id);
    if (!after) {
      removedRecords.push(before);
      symbolChanges.set(id, { id, kind: 'removed', before, deltas: [], contractStable: false });
      continue;
    }
    const deltas = contractDeltas(before, after);
    if (deltas.length === 0) continue;
    symbolChanges.set(id, {
      id,
      kind: 'modified',
      before,
      after,
      deltas,
      contractStable: deltas.every((d) => d.kind === 'body-changed'),
    });
  }

  for (const [id, after] of headIndex.symbols) {
    if (parseSymbolId(id)?.kind === 'module') continue;
    if (baseIndex.symbols.has(id)) continue;
    addedRecords.push(after);
    symbolChanges.set(id, { id, kind: 'added', after, deltas: [], contractStable: false });
  }

  const references = diffCollections(baseIndex.references, headIndex.references, referenceKey);
  const literals = diffCollections(baseIndex.literals, headIndex.literals, literalKey);
  const imports = diffCollections(baseIndex.imports, headIndex.imports, importKey);
  const exportSurface = diffCollections(baseIndex.exports, headIndex.exports, exportKey);

  const changedFiles = new Set<ModulePath>();
  for (const change of symbolChanges.values()) {
    const record = change.after ?? change.before;
    if (record) changedFiles.add(record.module);
  }
  for (const reference of [...references.added, ...references.removed]) {
    changedFiles.add(reference.range.module);
  }
  for (const entry of [...exportSurface.added, ...exportSurface.removed]) {
    changedFiles.add(entry.module);
  }

  return {
    branch,
    baseLabel,
    baseIndex,
    headIndex,
    symbolChanges,
    renames: detectRenames(removedRecords, addedRecords),
    addedReferences: references.added,
    removedReferences: references.removed,
    addedLiterals: literals.added,
    removedLiterals: literals.removed,
    addedImports: imports.added,
    removedImports: imports.removed,
    addedExports: exportSurface.added,
    removedExports: exportSurface.removed,
    changedFiles: [...changedFiles].sort(),
    diagnostics: [...baseIndex.diagnostics, ...headIndex.diagnostics],
  };
}
