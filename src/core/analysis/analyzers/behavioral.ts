import type { Evidence, Finding } from '../../model/findings.ts';
import { buildFinding, confidence, symbolLabel } from '../findings-builder.ts';
import type { Analyzer, PairContext } from '../context.ts';
import { describeDelta } from '../../changes/model.ts';

const MAX_CALLERS_SHOWN = 4;

/**
 * One branch changed an implementation; the other added callers of it.
 *
 * Hairline cannot decide whether a body change altered behaviour — that is
 * undecidable in general, and the honest thing is to say so. What it *can*
 * establish is that the two edits meet: code written against the old
 * behaviour is landing next to a new implementation, and no test on either
 * branch ever exercised the combination.
 *
 * This is reported as a *risk*, never as a conflict, and only when the change
 * carries a signal beyond "the body differs": a changed default argument, a
 * changed constant, or a large rewrite. A rule that fired on every body change
 * would flag most of a normal day's work and be switched off within a week —
 * which is how the published static conflict detectors ended up at roughly
 * 43% precision.
 */
export const behavioralRiskAnalyzer: Analyzer = {
  id: 'behavioral-risk',
  description:
    'A branch changed an implementation (or a default/constant) that code added by another branch newly depends on.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];

    for (const [id, change] of context.producer.changes.symbolChanges) {
      if (change.kind !== 'modified') continue;

      const valueChanges = change.deltas.filter(
        (d) => d.kind === 'parameter-default-changed' || d.kind === 'initializer-changed',
      );
      const bodyChanged = change.deltas.some((d) => d.kind === 'body-changed');
      if (valueChanges.length === 0 && !bodyChanged) continue;

      // Contract-affecting changes are the other analyzers' business; this one
      // only speaks when nothing stronger applies.
      const hasStructuralChange = change.deltas.some(
        (d) =>
          d.kind !== 'body-changed' &&
          d.kind !== 'parameter-default-changed' &&
          d.kind !== 'initializer-changed',
      );
      if (hasStructuralChange) continue;

      const callers = context.consumer.freshReferencesTo(id);
      if (callers.length === 0) continue;

      // Without a value-level signal, a body edit under a new caller is just
      // ordinary concurrent work. Saying so would be noise.
      if (valueChanges.length === 0) continue;

      const evidence: Evidence[] = valueChanges.map((delta) => ({
        kind: 'body-changed',
        branch: context.producer.label,
        symbol: id,
        summary: `\`${symbolLabel(id)}\`: ${describeDelta(delta)}`,
        ...('before' in delta && typeof delta.before === 'string' ? { before: delta.before } : {}),
        ...('after' in delta && typeof delta.after === 'string' ? { after: delta.after } : {}),
        ...(change.after ? { range: change.after.range } : {}),
      }));

      for (const caller of callers.slice(0, MAX_CALLERS_SHOWN)) {
        evidence.push({
          kind: 'reference-site',
          branch: context.consumer.label,
          summary: `New ${caller.kind} of \`${caller.name}\``,
          range: caller.range,
          symbol: caller.from,
        });
      }

      findings.push(
        buildFinding({
          analyzer: 'behavioral-risk',
          category: 'behavioral-risk',
          severity: 'medium',
          confidence: confidence(
            'low',
            'value-change-under-new-consumer',
            'A value the implementation depends on changed, and new code consumes the result. Hairline cannot tell whether the observable behaviour changed — no static analysis here establishes that. This is a prompt to look, not a claim that the merge is broken.',
          ),
          branches: [context.producer.label, context.consumer.label],
          symbols: [id],
          files: [
            ...(change.after ? [change.after.module] : []),
            ...callers.map((c) => c.range.module),
          ],
          title: `\`${symbolLabel(id)}\` changed value on ${context.producer.label} under new consumers on ${context.consumer.label}`,
          description:
            `${context.producer.label} changes a value inside \`${symbolLabel(id)}\` without changing its type. ` +
            `${context.consumer.label} adds ${callers.length} new ${callers.length === 1 ? 'consumer' : 'consumers'}. ` +
            `The signature is identical, so neither a type check nor a merge will notice — but the new code was written against the old value.`,
          evidence,
          verification: `Confirm the new consumers on ${context.consumer.label} are correct against the updated value, not the one at the merge base.`,
        }),
      );
    }

    return findings;
  },
};
