import type { Evidence, Finding, Severity } from '../../model/findings.ts';
import type { LiteralObservation } from '../../model/references.ts';
import type { ConfidenceLevel } from '../../model/findings.ts';
import type { SourceRange } from '../../model/source.ts';
import { parseSymbolId, type SymbolId } from '../../model/ids.ts';
import { displayTypeText } from '../../model/contracts.ts';
import { buildFinding, confidence, symbolLabel } from '../findings-builder.ts';
import type { Analyzer, PairContext } from '../context.ts';

/**
 * A site's type is "widened" when the checker sees a plain primitive rather
 * than the constrained union — `function render(s: string)` taking a value
 * that is conceptually a `Status`. These are the sites a type check *cannot*
 * flag even in principle, and the reason this analyzer exists.
 */
const WIDE_TYPES = new Set(['string', 'number', 'any', 'unknown', 'string | undefined', 'any']);

function isWidened(observation: LiteralObservation): boolean {
  const text = observation.siteTypeText;
  if (text === undefined) return true;
  return WIDE_TYPES.has(displayTypeText(text));
}

interface Linkage {
  readonly level: ConfidenceLevel;
  readonly basis: string;
  readonly rationale: string;
  readonly severity: Severity;
  readonly note: string;
}

/**
 * How strongly an observation of a removed value is tied to the type that
 * stopped admitting it.
 *
 * The three tiers are the honest gradient of what the index can support, and
 * they are the core of this analyzer's precision story:
 *
 *  - The site is typed by the very symbol that changed. Decidable.
 *  - The site's type has been widened to a primitive, but the code sits in a
 *    module that transitively imports the changed one. Strongly suggestive,
 *    not decidable — and invisible to a type checker, which is the point.
 *  - The value merely matches, with no import path connecting the two. Weak;
 *    reported at low confidence so it can be filtered out wholesale.
 */
function linkageFor(
  context: PairContext,
  observation: LiteralObservation,
  changedSymbol: SymbolId,
  changedModule: string,
): Linkage | undefined {
  if (observation.against === changedSymbol || observation.viaSymbol === changedSymbol) {
    return {
      level: 'high',
      basis: 'removed-literal-observed-against-changed-type',
      rationale:
        'The consuming site is typed by the very symbol whose admissible values changed, so the value it names is no longer one the type permits.',
      severity: 'high',
      note: 'typed directly by the changed symbol',
    };
  }

  const reachable = context.consumer.graph.modulesReaching(changedModule);
  const distance = reachable.get(observation.range.module);
  if (distance !== undefined) {
    return isWidened(observation)
      ? {
          level: 'medium',
          basis: 'removed-literal-observed-at-widened-site',
          rationale:
            'The value is named in a module that imports the changed one, but the type at that site has been widened to a primitive. A type check of the merged tree would not flag it; whether the value still reaches this code is not decided here.',
          severity: 'high',
          note: `type at the site is \`${displayTypeText(observation.siteTypeText ?? 'unknown')}\`, so a type check cannot see this`,
        }
      : {
          level: 'medium',
          basis: 'removed-literal-observed-in-dependent-module',
          rationale:
            'The value is named in a module that transitively imports the changed one, but the site is not typed by the changed symbol, so the connection is by dependency rather than by type.',
          severity: 'medium',
          note: `module is ${distance} import hop${distance === 1 ? '' : 's'} from the change`,
        };
  }

  return {
    level: 'low',
    basis: 'removed-literal-value-matches-elsewhere',
    rationale:
      'Only the literal text matches. No import path connects this code to the changed type, so this may well be an unrelated use of the same string.',
    severity: 'low',
    note: 'no import path connects this code to the change',
  };
}

interface RemovalSource {
  readonly id: SymbolId;
  readonly module: string;
  readonly before: string;
  readonly after: string;
  readonly range?: SourceRange;
  /** True for the declaration a reader should be pointed at (the alias or enum). */
  readonly primary: boolean;
}

interface RemovalGroup {
  readonly value: string;
  readonly sources: RemovalSource[];
}

const RANK: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2 };

/**
 * One branch narrowed the set of values a type admits; the other branch added
 * code that names a value that is no longer in the set.
 *
 * This is Hairline's sharpest differentiator. A type check of the merged tree
 * catches the subset of these where the consuming site is still precisely
 * typed. It cannot catch the rest — a `switch` on a `string` parameter, a
 * lookup table built at runtime, a JavaScript consumer — because by the time
 * the value reaches that code the type system has nothing left to check
 * against. Those are exactly the cases reported here at medium confidence,
 * with the site's actual type shown so the reader can judge.
 */
export const literalSetAnalyzer: Analyzer = {
  id: 'literal-set-change',
  description:
    'A branch removed a value from a type\'s admissible set while another branch added code naming that value.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];

    /**
     * Group removals by the value removed, not by the symbol that lost it.
     *
     * Narrowing `Status` also narrows every property typed by it, so one edit
     * produces a removal delta on several symbols. They are all the same
     * event, and reporting them separately would triple the apparent finding
     * count for a single change.
     */
    const byValue = new Map<string, RemovalGroup>();

    for (const [id, change] of context.producer.contractChanges()) {
      // A set that also admits arbitrary values of the base type cannot be
      // used to argue any particular value became impossible.
      if (change.after?.contract.literals?.open === true) continue;

      const parts = parseSymbolId(id);
      const module = change.after?.module ?? change.before?.module ?? parts?.module;
      if (!module) continue;

      for (const delta of change.deltas) {
        if (delta.kind !== 'literal-removed') continue;
        const group = byValue.get(delta.value);
        const entry: RemovalSource = {
          id,
          module,
          before: (change.before?.contract.literals?.values ?? []).join(' | '),
          after: (change.after?.contract.literals?.values ?? []).join(' | '),
          ...(change.after ? { range: change.after.range } : {}),
          // A type alias or enum is the thing a reader should be pointed at;
          // a property that merely references it is a consequence.
          primary: parts?.kind === 'type-alias' || parts?.kind === 'enum',
        };
        if (group) group.sources.push(entry);
        else byValue.set(delta.value, { value: delta.value, sources: [entry] });
      }
    }

    for (const group of byValue.values()) {
      const observations = context.consumer
        .freshLiterals()
        .filter((o) => o.value === group.value && o.context !== 'literal-type');
      if (observations.length === 0) continue;

      const primary = group.sources.find((s) => s.primary) ?? group.sources[0]!;
      const allIds = group.sources.map((s) => s.id);

      const linked = observations
        .map((o) => ({
          observation: o,
          // Linkage is evaluated against every symbol that lost the value, and
          // the strongest wins: a site typed by `Status` should not be demoted
          // just because it is not typed by `User.status`.
          linkage: group.sources
            .map((source) => linkageFor(context, o, source.id, source.module))
            .filter((l): l is Linkage => l !== undefined)
            .sort((a, b) => RANK[a.level] - RANK[b.level])[0],
        }))
        .filter((e): e is { observation: LiteralObservation; linkage: Linkage } =>
          e.linkage !== undefined,
        );
      if (linked.length === 0) continue;

      linked.sort((a, b) => RANK[a.linkage.level] - RANK[b.linkage.level]);
      const best = linked[0]!.linkage;
      const sameTier = linked.filter((e) => e.linkage.basis === best.basis);
      const count = sameTier.length;

      const evidence: Evidence[] = [
        {
          kind: 'literal-removed',
          branch: context.producer.label,
          symbol: primary.id,
          summary: `\`${symbolLabel(primary.id)}\`: literal ${group.value} removed from the admissible set`,
          before: primary.before,
          after: primary.after,
          ...(primary.range ? { range: primary.range } : {}),
        },
      ];
      if (group.sources.length > 1) {
        evidence.push({
          kind: 'type-changed',
          branch: context.producer.label,
          symbol: primary.id,
          summary: `Also narrows ${group.sources.length - 1} symbol(s) typed by it: ${group.sources
            .filter((s) => s.id !== primary.id)
            .map((s) => symbolLabel(s.id))
            .join(', ')}`,
        });
      }

      for (const { observation, linkage } of sameTier.slice(0, 6)) {
        evidence.push({
          kind: 'literal-site',
          branch: context.consumer.label,
          summary: `New ${observation.context.replace('-', ' ')} on ${observation.value}${observation.againstName ? ` against \`${observation.againstName}\`` : ''} — ${linkage.note}`,
          range: observation.range,
          symbol: observation.enclosing,
          ...(observation.siteTypeText ? { after: displayTypeText(observation.siteTypeText) } : {}),
        });
      }

      const invisibleToTypeCheck = best.basis === 'removed-literal-observed-at-widened-site';

      findings.push(
        buildFinding({
          analyzer: 'literal-set-change',
          category: 'literal-set-conflict',
          severity: best.severity,
          confidence: confidence(best.level, best.basis, best.rationale),
          branches: [context.producer.label, context.consumer.label],
          symbols: [primary.id, ...allIds.filter((id) => id !== primary.id)],
          files: [primary.module, ...sameTier.map((e) => e.observation.range.module)],
          title: `${context.producer.label} removes ${group.value} from \`${symbolLabel(primary.id)}\`; ${context.consumer.label} adds code handling it`,
          description:
            `${context.producer.label} narrows \`${symbolLabel(primary.id)}\` so that ${group.value} is no longer one of its values. ` +
            `${context.consumer.label} adds ${count} ${count === 1 ? 'site that still names' : 'sites that still name'} ${group.value}. ` +
            (invisibleToTypeCheck
              ? `${count === 1 ? 'That site is' : 'Those sites are'} typed loosely enough that type-checking the merged tree would not report this — the code would simply become unreachable at runtime.`
              : `After the merge ${count === 1 ? 'that branch is' : 'those branches are'} dead code.`),
          evidence,
          verification: invisibleToTypeCheck
            ? `Check whether the ${count === 1 ? 'branch' : 'branches'} handling ${group.value} on ${context.consumer.label} can still be reached, and whether removing the value was intended.`
            : `Type-check the merged tree, then confirm whether ${group.value} should still be supported.`,
        }),
      );
    }

    return findings;
  },
};
