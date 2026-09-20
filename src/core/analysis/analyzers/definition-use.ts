import { displayTypeText } from '../../model/contracts.ts';
import { describeDelta, deltaImpact, type ContractDelta } from '../../changes/model.ts';
import type { Evidence, Finding } from '../../model/findings.ts';
import type { Reference } from '../../model/references.ts';
import { parseSymbolId, type SymbolId, type SymbolKind } from '../../model/ids.ts';
import { buildFinding, confidence, symbolLabel } from '../findings-builder.ts';
import type { Analyzer, PairContext } from '../context.ts';

const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'function',
  'method',
  'class',
  'accessor',
  'constructor',
]);

/** The function or class a use site sits in, which is what a reader wants named. */
function containingDeclaration(context: PairContext, reference: Reference): SymbolId {
  return context.consumer.graph.enclosingOfKind(reference.from, CONTAINER_KINDS)?.id ?? reference.from;
}

function evidenceForReference(branch: string, reference: Reference, note: string): Evidence {
  return {
    kind: 'reference-site',
    branch,
    summary: note,
    range: reference.range,
    ...(reference.to ? { symbol: reference.to } : {}),
  };
}

/**
 * The symbol vanished, and the other branch introduced code that names it.
 *
 * This is the most clear-cut interaction Hairline detects: after the merge
 * there is a reference with nothing to resolve to. It is decidable from the
 * index alone, which is why it carries high confidence — no inference about
 * behaviour is involved.
 */
export const removedDefinitionAnalyzer: Analyzer = {
  id: 'removed-definition',
  description: 'A symbol one branch deleted or un-exported is used by code the other branch added.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];

    for (const [id, change] of context.producer.changes.symbolChanges) {
      const disappeared =
        change.kind === 'removed' ||
        change.deltas.some((d) => d.kind === 'export-removed' || d.kind === 'moved');
      if (!disappeared) continue;

      const uses = context.consumer.freshReferencesTo(id);
      if (uses.length === 0) continue;

      const rename = context.producer.changes.renames.find((r) => r.from === id);
      const removalEvidence: Evidence = {
        kind: change.kind === 'removed' ? 'symbol-removed' : 'export-removed',
        branch: context.producer.label,
        symbol: id,
        summary:
          change.kind === 'removed'
            ? `Deleted \`${symbolLabel(id)}\``
            : `Stopped exporting \`${symbolLabel(id)}\``,
        ...(change.before ? { range: change.before.range } : {}),
        ...(change.before?.contract.typeText
          ? { before: displayTypeText(change.before.contract.typeText) }
          : {}),
      };

      const evidence: Evidence[] = [removalEvidence];
      if (rename) {
        evidence.push({
          kind: 'symbol-renamed',
          branch: context.producer.label,
          symbol: rename.to,
          summary: `Looks like a rename to \`${symbolLabel(rename.to)}\` (${rename.reason})`,
          before: symbolLabel(rename.from),
          after: symbolLabel(rename.to),
        });
      }
      for (const use of uses.slice(0, 5)) {
        evidence.push(
          evidenceForReference(
            context.consumer.label,
            use,
            `New ${use.kind} of \`${use.name}\` in \`${symbolLabel(containingDeclaration(context, use))}\``,
          ),
        );
      }

      findings.push(
        buildFinding({
          analyzer: 'removed-definition',
          category: change.kind === 'removed' ? 'definition-use-conflict' : 'export-conflict',
          severity: 'high',
          confidence: confidence(
            'high',
            'removed-symbol-still-referenced',
            'Decided from the index alone: the definition is gone on one branch and the other branch adds code naming it. No behavioural inference is involved.',
          ),
          branches: [context.producer.label, context.consumer.label],
          symbols: [id],
          files: [
            ...(change.before ? [change.before.module] : []),
            ...uses.map((u) => u.range.module),
          ],
          title: `\`${symbolLabel(id)}\` is ${change.kind === 'removed' ? 'removed' : 'un-exported'} on ${context.producer.label} but newly used on ${context.consumer.label}`,
          description:
            `${context.producer.label} ${change.kind === 'removed' ? 'deletes' : 'stops exporting'} \`${symbolLabel(id)}\`. ` +
            `${context.consumer.label} independently adds ${uses.length} ${uses.length === 1 ? 'use' : 'uses'} of it. ` +
            `Neither branch is wrong on its own; together the ${uses.length === 1 ? 'reference has' : 'references have'} nothing to bind to.` +
            (rename ? ` The deletion may be a rename to \`${symbolLabel(rename.to)}\`, in which case the new uses need updating.` : ''),
          evidence,
          verification: rename
            ? `Point the new uses on ${context.consumer.label} at \`${symbolLabel(rename.to)}\`, then type-check the merged tree.`
            : `Type-check the merged tree, or check whether \`${symbolLabel(id)}\` should be restored.`,
        }),
      );
    }

    return findings;
  },
};

/** Reference kinds a given contract delta can actually reach. */
function reachedBy(delta: ContractDelta, reference: Reference): boolean {
  const impact = deltaImpact(delta);
  switch (reference.kind) {
    case 'call':
    case 'instantiate':
      return impact.callers;
    case 'read':
    case 'write':
    case 'property-access':
      return impact.readers;
    case 'type':
    case 'extends':
    case 'implements':
      return impact.implementers;
    case 'import':
    case 'export':
      return impact.importers;
    case 'unknown':
      return false;
  }
}

/**
 * The call signature moved under a call site the other branch introduced.
 *
 * Arity is checked exactly, because it is checkable: if the new signature
 * needs two arguments and the new call site passes one, the merge is broken
 * and Hairline can say so without hedging. Type-level parameter changes get a
 * lower confidence, because deciding assignability would mean re-implementing
 * the checker on a tree that does not exist yet.
 */
export const signatureAnalyzer: Analyzer = {
  id: 'signature-change',
  description: 'A call signature one branch changed is called by code the other branch added.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];

    for (const [id, change] of context.producer.contractChanges()) {
      const signatureDeltas = change.deltas.filter(
        (d) =>
          d.kind === 'parameter-removed' ||
          d.kind === 'parameter-added' ||
          d.kind === 'parameter-type-changed' ||
          d.kind === 'parameter-optionality-changed' ||
          d.kind === 'required-arity-changed' ||
          d.kind === 'return-type-changed' ||
          d.kind === 'nullability-changed' ||
          d.kind === 'async-boundary-changed',
      );
      if (signatureDeltas.length === 0) continue;

      const calls = context.consumer
        .freshReferencesTo(id)
        .filter((r) => signatureDeltas.some((d) => reachedBy(d, r)));
      if (calls.length === 0) continue;

      const newArity = change.after?.contract.callable?.[0];
      const arityBroken = newArity
        ? calls.filter(
            (call) =>
              call.kind === 'call' &&
              call.argumentCount !== undefined &&
              !call.spreadArguments &&
              (call.argumentCount < newArity.requiredParameterCount ||
                (!newArity.acceptsRest && call.argumentCount > newArity.parameters.length)),
          )
        : [];

      const nullability = signatureDeltas.find(
        (d) => d.kind === 'nullability-changed' && d.nowNullable,
      );

      /**
       * A synchronous-to-asynchronous change is decidable at a call site whose
       * handling of the result is known: one that does not await now holds a
       * Promise where it expected a value. A site that already awaits is fine,
       * so the finding is raised only for the ones that do not — which is what
       * keeps the compatible-caller case silent.
       */
      const asyncBoundary = signatureDeltas.find((d) => d.kind === 'async-boundary-changed');
      const unawaitedCalls =
        asyncBoundary?.kind === 'async-boundary-changed' && asyncBoundary.nowAsync
          ? calls.filter((call) => call.kind === 'call' && call.awaited === false)
          : [];

      /**
       * Crossing the async boundary always changes the return type, so those
       * two deltas travel together and describe one event. When they are the
       * *only* change, every new call site that consumes the result as a
       * promise is already compatible — and `await` on a non-promise is legal,
       * so the reverse direction is compatible too. Reporting anyway would
       * flag the correctly-written caller, which is the exact case this
       * analyzer has to stay quiet about.
       */
      const asyncBoundaryOnly =
        asyncBoundary !== undefined &&
        signatureDeltas.every(
          (d) => d.kind === 'async-boundary-changed' || d.kind === 'return-type-changed',
        );
      if (asyncBoundaryOnly && unawaitedCalls.length === 0) continue;

      const evidence: Evidence[] = signatureDeltas.map((delta) => ({
        kind: 'signature-changed',
        branch: context.producer.label,
        symbol: id,
        summary: describeDelta(delta),
        ...(change.after ? { range: change.after.range } : {}),
      }));

      const highlighted =
        arityBroken.length > 0 ? arityBroken : unawaitedCalls.length > 0 ? unawaitedCalls : calls;
      for (const call of highlighted.slice(0, 5)) {
        evidence.push(
          evidenceForReference(
            context.consumer.label,
            call,
            call.argumentCount !== undefined
              ? `New call passing ${call.argumentCount} argument${call.argumentCount === 1 ? '' : 's'}${call.awaited === false && unawaitedCalls.length > 0 ? ', and not awaited,' : ''} in \`${symbolLabel(containingDeclaration(context, call))}\``
              : `New ${call.kind} in \`${symbolLabel(containingDeclaration(context, call))}\``,
          ),
        );
      }

      const decidable = arityBroken.length > 0 || unawaitedCalls.length > 0;
      findings.push(
        buildFinding({
          analyzer: 'signature-change',
          category: 'signature-conflict',
          severity: decidable ? 'high' : nullability ? 'high' : 'medium',
          confidence: arityBroken.length > 0
            ? confidence(
                'high',
                'arity-mismatch-at-new-call-site',
                `The new signature requires ${newArity?.requiredParameterCount} argument(s) and the new call site does not supply a compatible count. Decided by counting, not by inference.`,
              )
            : unawaitedCalls.length > 0
              ? confidence(
                  'high',
                  'result-became-a-promise-at-an-unawaited-call-site',
                  'The function became asynchronous and the new call site uses its result directly rather than awaiting it, so after the merge that code holds a Promise where it expects a value.',
                )
            : nullability
              ? confidence(
                  'medium',
                  'result-became-nullable-under-new-consumer',
                  'The result can now be null or undefined where it previously could not, and the consuming code is new. Whether the consumer guards against it is not decided here.',
                )
              : confidence(
                  'medium',
                  'signature-changed-under-new-call-site',
                  'The parameters changed and the call site is new, so the two were never checked together. Deciding assignability would require type-checking the merged tree, which Hairline does not do.',
                ),
          branches: [context.producer.label, context.consumer.label],
          symbols: [id],
          files: [
            ...(change.after ? [change.after.module] : []),
            ...calls.map((c) => c.range.module),
          ],
          title: `\`${symbolLabel(id)}\` changed signature on ${context.producer.label} under ${calls.length} new call site${calls.length === 1 ? '' : 's'} on ${context.consumer.label}`,
          description:
            `${context.producer.label} changes the signature of \`${symbolLabel(id)}\` (${signatureDeltas.map(describeDelta).join('; ')}). ` +
            `${context.consumer.label} adds code that calls it. ` +
            (arityBroken.length > 0
              ? `At least one new call site passes an argument count the new signature cannot accept.`
              : unawaitedCalls.length > 0
                ? `${unawaitedCalls.length} of those call ${unawaitedCalls.length === 1 ? 'sites uses' : 'sites use'} the result directly instead of awaiting it.`
                : `Whether the new call sites still satisfy the new signature was not checked together on either branch.`),
          evidence,
          verification:
            unawaitedCalls.length > 0
              ? `Await the new calls to \`${symbolLabel(id)}\` on ${context.consumer.label}, and make their callers asynchronous.`
              : decidable
                ? `Update the new call sites on ${context.consumer.label} to match the new signature.`
                : `Type-check the merged tree, focusing on calls to \`${symbolLabel(id)}\`.`,
        }),
      );
    }

    return findings;
  },
};

/**
 * A member of a shared type changed under code that reads or writes it.
 *
 * Kept separate from the signature analyzer because the consumers differ:
 * a member change reaches readers and implementers, while a signature change
 * reaches callers, and conflating them produces findings pointed at the wrong
 * code.
 */
export const memberAnalyzer: Analyzer = {
  id: 'member-change',
  description: 'A type member one branch changed is read or written by code the other branch added.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];

    for (const [id, change] of context.producer.contractChanges()) {
      const memberDeltas = change.deltas.filter(
        (d) =>
          d.kind === 'member-removed' ||
          d.kind === 'member-renamed' ||
          d.kind === 'member-type-changed' ||
          d.kind === 'member-optionality-changed' ||
          // Modifier changes break consumers just as thoroughly as type
          // changes, and are easier to make by accident.
          d.kind === 'member-visibility-changed' ||
          d.kind === 'member-readonly-changed' ||
          d.kind === 'member-static-changed',
      );
      if (memberDeltas.length === 0) continue;

      const parts = parseSymbolId(id);
      if (!parts) continue;

      for (const delta of memberDeltas) {
        const memberName =
          delta.kind === 'member-renamed' ? delta.before : 'name' in delta ? delta.name : undefined;
        // Narrowing visibility hides the member from outside the class; the
        // member is still there, so this is not a removal, but every external
        // reader stops compiling.
        const hidden =
          delta.kind === 'member-visibility-changed' && delta.after !== 'public';
        if (memberName === undefined) continue;

        // Use sites bind to the member's own identity, not to the containing
        // type, so the member has to be located before its consumers can be.
        const memberSymbolId = findMemberId(context, parts.module, parts.path, memberName);
        if (!memberSymbolId) continue;

        const uses = context.consumer
          .freshReferencesTo(memberSymbolId)
          .filter((r) => reachedBy(delta, r));
        if (uses.length === 0) continue;

        const removed = delta.kind === 'member-removed' || delta.kind === 'member-renamed';
        const decidable = removed || hidden || delta.kind === 'member-static-changed';
        const evidence: Evidence[] = [
          {
            kind:
              delta.kind === 'member-removed'
                ? 'member-removed'
                : delta.kind === 'member-renamed'
                  ? 'symbol-renamed'
                  : 'member-type-changed',
            branch: context.producer.label,
            symbol: id,
            summary: `\`${symbolLabel(id)}\`: ${describeDelta(delta)}`,
            ...(change.after ? { range: change.after.range } : {}),
            ...('before' in delta && typeof delta.before === 'string'
              ? { before: displayTypeText(delta.before) }
              : {}),
            ...('after' in delta && typeof delta.after === 'string'
              ? { after: displayTypeText(delta.after) }
              : {}),
          },
        ];
        for (const use of uses.slice(0, 5)) {
          evidence.push(
            evidenceForReference(
              context.consumer.label,
              use,
              `New ${use.kind} of \`.${use.name}\` in \`${symbolLabel(containingDeclaration(context, use))}\``,
            ),
          );
        }

        findings.push(
          buildFinding({
            analyzer: 'member-change',
            category: removed ? 'definition-use-conflict' : 'type-conflict',
            severity: decidable ? 'high' : 'medium',
            confidence: removed
              ? confidence(
                  'high',
                  'removed-member-still-accessed',
                  'The member does not exist after the merge and the access is new, so it cannot resolve. Decided from the index.',
                )
              : hidden
                ? confidence(
                    'high',
                    'member-hidden-under-new-external-access',
                    'The member is no longer public and the accessing code is new and outside the declaration. Decided from the index: the access cannot compile after the merge.',
                  )
                : delta.kind === 'member-static-changed'
                  ? confidence(
                      'high',
                      'member-moved-between-instance-and-static',
                      'The member moved between the instance and static sides, so every new use site spells the access the wrong way round. Decided from the index.',
                    )
                  : confidence(
                      'medium',
                      'member-changed-under-new-access',
                      'The member changed and the accessing code is new. Whether the new shape still satisfies the new consumer is not decided here.',
                    ),
            branches: [context.producer.label, context.consumer.label],
            symbols: [id, memberSymbolId],
            files: [
              ...(change.after ? [change.after.module] : []),
              ...uses.map((u) => u.range.module),
            ],
            title: `\`${symbolLabel(id)}.${memberName}\` changed on ${context.producer.label} under new access on ${context.consumer.label}`,
            description:
              `${context.producer.label} changes \`${symbolLabel(id)}\`: ${describeDelta(delta)}. ` +
              `${context.consumer.label} adds ${uses.length} ${uses.length === 1 ? 'access' : 'accesses'} of \`.${memberName}\`. ` +
              `The two were never seen together by either branch's type check.`,
            evidence,
            verification:
              delta.kind === 'member-renamed'
                ? `Rename the new accesses on ${context.consumer.label} to \`.${delta.after}\`.`
                : `Type-check the merged tree, focusing on \`.${memberName}\` accesses.`,
          }),
        );
      }
    }

    return findings;
  },
};

/** Locate the identity of a named member of a container symbol. */
function findMemberId(
  context: PairContext,
  module: string,
  containerPath: readonly string[],
  member: string,
): SymbolId | undefined {
  const wanted = [...containerPath, member].join('.');
  for (const graph of [context.producer.baseGraph, context.producer.graph, context.consumer.graph]) {
    for (const symbol of graph.symbolsInModule(module)) {
      const parts = parseSymbolId(symbol.id);
      if (parts && parts.path.join('.') === wanted) return symbol.id;
    }
  }
  return undefined;
}
