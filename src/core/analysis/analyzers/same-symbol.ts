import { describeDelta, type ContractDelta, type SymbolChange } from '../../changes/model.ts';
import type { Evidence, Finding, Severity } from '../../model/findings.ts';
import type { ConfidenceLevel } from '../../model/findings.ts';
import { displayTypeText } from '../../model/contracts.ts';
import { buildFinding, confidence, symbolLabel } from '../findings-builder.ts';
import type { Analyzer, PairContext } from '../context.ts';

/** A stable key for "these two deltas are about the same thing". */
function subject(delta: ContractDelta): string {
  switch (delta.kind) {
    case 'parameter-removed':
    case 'parameter-added':
    case 'parameter-type-changed':
    case 'parameter-optionality-changed':
    case 'parameter-default-changed':
      return `parameter:${delta.name}`;
    case 'member-added':
    case 'member-removed':
    case 'member-type-changed':
    case 'member-optionality-changed':
      return `member:${delta.name}`;
    case 'member-renamed':
      return `member:${delta.before}`;
    case 'literal-added':
    case 'literal-removed':
      return `literal:${delta.value}`;
    case 'return-type-changed':
    case 'nullability-changed':
      return 'return';
    case 'required-arity-changed':
      return 'arity';
    case 'type-text-changed':
      return 'type';
    case 'export-removed':
    case 'export-added':
    case 'export-kind-changed':
      return 'export';
    case 'heritage-changed':
      return 'heritage';
    case 'initializer-changed':
      return 'initializer';
    case 'body-changed':
      return 'body';
    case 'kind-changed':
      return 'kind';
    case 'overload-count-changed':
      return 'overloads';
    case 'moved':
      return 'location';
    default:
      // Exhaustive today; the default keeps a newly added delta kind from
      // silently comparing equal to an unrelated one.
      return `other:${(delta as { kind: string }).kind}`;
  }
}

/** True when two deltas about the same subject cannot both be honoured. */
function contradicts(a: ContractDelta, b: ContractDelta): boolean {
  if (a.kind === 'literal-removed' && b.kind === 'literal-added') return a.value === b.value;
  if (a.kind === 'literal-added' && b.kind === 'literal-removed') return a.value === b.value;
  if (a.kind === 'member-removed' && b.kind === 'member-type-changed') return a.name === b.name;
  if (a.kind === 'member-type-changed' && b.kind === 'member-removed') return a.name === b.name;

  // Deltas that carry an `after` value disagree exactly when the values differ:
  // both branches moved the same thing, to different places.
  const AFTER_VALUED = new Set<ContractDelta['kind']>([
    'parameter-type-changed',
    'member-type-changed',
    'return-type-changed',
    'type-text-changed',
    'required-arity-changed',
  ]);
  if (a.kind === b.kind && AFTER_VALUED.has(a.kind)) {
    const left = (a as { after?: unknown }).after;
    const right = (b as { after?: unknown }).after;
    return left !== right;
  }
  if (a.kind === 'member-renamed' && b.kind === 'member-renamed') {
    return a.before === b.before && a.after !== b.after;
  }
  if (a.kind === 'export-removed' && b.kind === 'export-added') return true;
  if (a.kind === 'export-added' && b.kind === 'export-removed') return true;

  return false;
}

/**
 * A comparable summary of what a symbol's contract *became* on one branch.
 *
 * Comparing outcomes is stronger evidence than comparing edits. Two branches
 * can reach the same place by different routes (both add the same field), and
 * they can take the same route to different places (both replace a union
 * member, with different replacements). Only the destination decides whether
 * the merge can satisfy both.
 */
function resultingContract(change: SymbolChange): string | undefined {
  const after = change.after?.contract;
  if (!after || !after.typeResolved) return undefined;
  return JSON.stringify([
    after.typeText,
    after.literals?.values ?? null,
    after.initializerText ?? null,
    after.callable?.map((c) => [c.parameters.map((p) => [p.name, p.typeText, p.optional]), c.returnTypeText]) ?? null,
    after.object?.members.map((m) => [m.name, m.typeText, m.optional]) ?? null,
  ]);
}

/**
 * Both branches moved the same contract.
 *
 * Git resolves this textually whenever the edits are far enough apart in the
 * file — two branches can each add a field to the same interface, or each
 * change a different parameter of the same function, and merge without a
 * murmur. Whether the *combination* is coherent is a question about the
 * contract, not about the lines, and that is what this analyzer asks.
 *
 * Note this analyzer is direction-free: it reports on a pair, not on a
 * producer and a consumer, so the engine runs it once per unordered pair.
 */
export const sameSymbolAnalyzer: Analyzer = {
  id: 'same-symbol',
  description: 'Both branches changed the same symbol\'s contract.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];
    // Run once per unordered pair; the engine calls both orderings.
    if (context.producer.label > context.consumer.label) return findings;

    for (const [id, left] of context.producer.contractChanges()) {
      const right = context.consumer.contractChanges().get(id);
      if (!right) continue;

      const leftBySubject = new Map<string, ContractDelta[]>();
      for (const delta of left.deltas) {
        if (delta.kind === 'body-changed') continue;
        const key = subject(delta);
        const bucket = leftBySubject.get(key);
        if (bucket) bucket.push(delta);
        else leftBySubject.set(key, [delta]);
      }

      const contradictions: Array<{ left: ContractDelta; right: ContractDelta }> = [];
      const overlapping: Array<{ left: ContractDelta; right: ContractDelta }> = [];

      for (const delta of right.deltas) {
        if (delta.kind === 'body-changed') continue;
        for (const counterpart of leftBySubject.get(subject(delta)) ?? []) {
          if (contradicts(counterpart, delta)) contradictions.push({ left: counterpart, right: delta });
          else overlapping.push({ left: counterpart, right: delta });
        }
      }

      const bothRemoved = left.kind === 'removed' && right.kind === 'removed';
      const oneRemoved = !bothRemoved && (left.kind === 'removed' || right.kind === 'removed');

      // The decisive test: did the two branches arrive at different contracts?
      // If so, the merge can only keep one, and the losing branch's code was
      // written against the other.
      const leftResult = resultingContract(left);
      const rightResult = resultingContract(right);
      const divergentOutcome =
        leftResult !== undefined && rightResult !== undefined && leftResult !== rightResult;

      if (contradictions.length === 0 && overlapping.length === 0 && !oneRemoved) continue;

      const evidence: Evidence[] = [];
      const pairsToShow = contradictions.length > 0 ? contradictions : overlapping;
      for (const pair of pairsToShow.slice(0, 5)) {
        evidence.push({
          kind: 'type-changed',
          branch: context.producer.label,
          symbol: id,
          summary: `${context.producer.label}: ${describeDelta(pair.left)}`,
          ...(left.after ? { range: left.after.range } : {}),
        });
        evidence.push({
          kind: 'type-changed',
          branch: context.consumer.label,
          symbol: id,
          summary: `${context.consumer.label}: ${describeDelta(pair.right)}`,
          ...(right.after ? { range: right.after.range } : {}),
        });
      }
      if (oneRemoved) {
        const remover = left.kind === 'removed' ? context.producer : context.consumer;
        const keeper = left.kind === 'removed' ? context.consumer : context.producer;
        const keeperChange = left.kind === 'removed' ? right : left;
        evidence.push({
          kind: 'symbol-removed',
          branch: remover.label,
          symbol: id,
          summary: `${remover.label} deletes \`${symbolLabel(id)}\``,
        });
        evidence.push({
          kind: 'type-changed',
          branch: keeper.label,
          symbol: id,
          summary: `${keeper.label} changes it instead: ${keeperChange.deltas.map(describeDelta).join('; ') || 'edits it'}`,
          ...(keeperChange.after ? { range: keeperChange.after.range } : {}),
        });
      }

      const decisive = contradictions.length > 0 || oneRemoved || divergentOutcome;
      const level: ConfidenceLevel = decisive ? 'high' : 'medium';
      const severity: Severity = decisive ? 'high' : 'medium';

      if (divergentOutcome && contradictions.length === 0 && !oneRemoved) {
        evidence.push({
          kind: 'type-changed',
          branch: context.producer.label,
          symbol: id,
          summary: `The two branches leave \`${symbolLabel(id)}\` in different states`,
          ...(left.after?.contract.typeText
            ? { before: displayTypeText(left.after.contract.typeText) }
            : {}),
          ...(right.after?.contract.typeText
            ? { after: displayTypeText(right.after.contract.typeText) }
            : {}),
        });
      }

      const typeSummary = (() => {
        const before = left.before?.contract.typeText;
        const a = left.after?.contract.typeText;
        const b = right.after?.contract.typeText;
        if (!before || !a || !b) return '';
        return ` Base was \`${displayTypeText(before)}\`; ${context.producer.label} has \`${displayTypeText(a)}\`, ${context.consumer.label} has \`${displayTypeText(b)}\`.`;
      })();

      findings.push(
        buildFinding({
          analyzer: 'same-symbol',
          category: 'same-symbol-conflict',
          severity,
          confidence: confidence(
            level,
            oneRemoved
              ? 'symbol-deleted-and-modified'
              : contradictions.length > 0 || divergentOutcome
                ? 'divergent-changes-to-same-contract'
                : 'concurrent-changes-to-same-contract',
            oneRemoved
              ? 'One branch deletes the symbol while the other keeps changing it. Git may take either side depending on how the edits land.'
              : contradictions.length > 0 || divergentOutcome
                ? 'Both branches left the same contract in different states. Only one can survive the merge, and the losing branch\'s code was written against the other. Decided by comparing the two resulting contracts, not by inference.'
                : 'Both branches changed the same contract, in ways that do not directly contradict. The combination may still be wrong, but nothing in the index proves it is.',
          ),
          branches: [context.producer.label, context.consumer.label],
          symbols: [id],
          files: [
            ...(left.after ? [left.after.module] : []),
            ...(right.after ? [right.after.module] : []),
            ...(left.before ? [left.before.module] : []),
          ],
          title:
            oneRemoved
              ? `\`${symbolLabel(id)}\` is deleted on one branch and modified on the other`
              : contradictions.length > 0 || divergentOutcome
                ? `\`${symbolLabel(id)}\` is changed incompatibly on both branches`
                : `\`${symbolLabel(id)}\` is changed on both branches`,
          description:
            `Both ${context.producer.label} and ${context.consumer.label} change \`${symbolLabel(id)}\`.` +
            (contradictions.length > 0
              ? ` ${contradictions.length} of those changes touch the same part of the contract and disagree about the result.`
              : divergentOutcome
                ? ` Each branch leaves it in a different state, so at most one of them survives the merge intact.`
                : oneRemoved
                  ? ''
                  : ` The changes do not directly contradict, but each branch's other code was written against its own version.`) +
            typeSummary,
          evidence,
          verification: `Review the merged definition of \`${symbolLabel(id)}\` and confirm it satisfies the code on both branches.`,
        }),
      );
    }

    return findings;
  },
};
