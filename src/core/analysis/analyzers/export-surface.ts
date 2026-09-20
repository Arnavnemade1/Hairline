import type { Evidence, Finding } from '../../model/findings.ts';
import type { ExportedName, ImportEdge } from '../../model/references.ts';
import { displayTypeText } from '../../model/contracts.ts';
import { buildFinding, confidence, symbolLabel } from '../findings-builder.ts';
import type { Analyzer, BranchView, PairContext } from '../context.ts';

/**
 * Import edges the consuming branch introduced or edited that name a given
 * export of a given module.
 *
 * Matched on the *specifier's resolved module* rather than on the specifier
 * text, so `./user`, `./user.js` and `../src/user.ts` all count as the same
 * dependency — which is what actually determines whether the import breaks.
 */
function freshImportsOf(
  consumer: BranchView,
  entry: ExportedName,
): ImportEdge[] {
  return consumer.changes.addedImports.filter(
    (edge) => edge.to === entry.module && edge.names.includes(entry.name),
  );
}

/**
 * Consumers that reach the export through `import * as ns`, which names no
 * individual member and so cannot be matched by name.
 */
function freshNamespaceImportsOf(consumer: BranchView, entry: ExportedName): ImportEdge[] {
  return consumer.changes.addedImports.filter(
    (edge) => edge.to === entry.module && edge.namespaceImport && !edge.dynamic,
  );
}

/**
 * One branch narrowed a module's public surface; the other branch added an
 * import of a name that is no longer there.
 *
 * This is distinct from deleting a symbol, and the difference matters in
 * practice. A barrel file declares nothing: narrowing `export { a, b }` to
 * `export { b }`, or replacing `export *` with an explicit list, removes `a`
 * from the package's entry point while `a` itself is completely untouched.
 * Nothing in a symbol-level comparison sees that, because no symbol changed —
 * only the surface did. Barrels are ubiquitous in TypeScript, and this is one
 * of the easiest ways for two agents to break each other without either
 * touching the same declaration.
 */
export const exportSurfaceAnalyzer: Analyzer = {
  id: 'export-surface',
  description:
    'A module stopped exporting a name that code added by the other branch imports.',

  analyze(context: PairContext): Finding[] {
    const findings: Finding[] = [];

    // A name that moved to a different module is still gone from this one, but
    // saying so is more useful than reporting a bare removal.
    const addedElsewhere = new Map<string, ExportedName>();
    for (const entry of context.producer.changes.addedExports) {
      addedElsewhere.set(entry.name, entry);
    }

    for (const entry of context.producer.changes.removedExports) {
      const named = freshImportsOf(context.consumer, entry);
      const namespaced = named.length === 0 ? freshNamespaceImportsOf(context.consumer, entry) : [];
      const importers = [...named, ...namespaced];
      if (importers.length === 0) continue;

      // If the declaration itself was deleted, `removed-definition` already
      // reports it with stronger evidence; this analyzer is for the case where
      // the declaration survived and only the surface changed.
      const stillDeclared =
        entry.target !== undefined && context.producer.graph.symbol(entry.target) !== undefined;

      const movedTo = addedElsewhere.get(entry.name);
      const isMove = movedTo !== undefined && movedTo.module !== entry.module;

      const evidence: Evidence[] = [
        {
          kind: 'export-removed',
          branch: context.producer.label,
          summary: isMove
            ? `\`${entry.module}\` no longer exports \`${entry.name}\`; it now comes from \`${movedTo.module}\``
            : `\`${entry.module}\` no longer exports \`${entry.name}\`${entry.viaStar ? ' (it previously arrived via `export *`)' : ''}`,
          range: entry.range,
          ...(entry.target ? { symbol: entry.target } : {}),
          ...(entry.typeText ? { before: displayTypeText(entry.typeText) } : {}),
        },
      ];

      if (stillDeclared && entry.target) {
        evidence.push({
          kind: 'export-removed',
          branch: context.producer.label,
          summary: `\`${symbolLabel(entry.target)}\` still exists — only the module's public surface changed`,
          symbol: entry.target,
        });
      }

      for (const edge of importers.slice(0, 5)) {
        evidence.push({
          kind: 'import-site',
          branch: context.consumer.label,
          summary: edge.namespaceImport
            ? `New namespace import of \`${edge.specifier}\`, which no longer provides \`${entry.name}\``
            : `New import of \`${entry.name}\` from \`${edge.specifier}\``,
          range: edge.range,
        });
      }

      // A namespace import does not name the member, so the connection is by
      // module rather than by name — real, but not decidable from the index.
      const decidable = named.length > 0;

      findings.push(
        buildFinding({
          analyzer: 'export-surface',
          category: 'export-conflict',
          severity: decidable ? 'high' : 'medium',
          confidence: decidable
            ? confidence(
                'high',
                'removed-export-newly-imported',
                'The module no longer provides this name and the other branch adds an import that asks for it by name. Decided from the index: after the merge the import has nothing to bind to.',
              )
            : confidence(
                'medium',
                'removed-export-under-new-namespace-import',
                'The module no longer provides this name and the other branch adds a namespace import of that module. Whether the new code actually reaches this member is not decided here.',
              ),
          branches: [context.producer.label, context.consumer.label],
          symbols: entry.target ? [entry.target] : [],
          files: [entry.module, ...importers.map((e) => e.from)],
          title: isMove
            ? `\`${entry.name}\` moved out of \`${entry.module}\` on ${context.producer.label}; ${context.consumer.label} imports it from there`
            : `\`${entry.module}\` stops exporting \`${entry.name}\` on ${context.producer.label}; ${context.consumer.label} newly imports it`,
          description:
            `${context.producer.label} removes \`${entry.name}\` from the public surface of \`${entry.module}\`. ` +
            `${context.consumer.label} adds ${importers.length} ${importers.length === 1 ? 'import' : 'imports'} that ${importers.length === 1 ? 'expects' : 'expect'} it to be there. ` +
            (stillDeclared
              ? `The declaration itself is untouched — only the module's exports changed, so nothing in a symbol-level comparison would show this.`
              : isMove
                ? `It appears to have moved to \`${movedTo.module}\`.`
                : `Neither branch is wrong alone; together the import cannot resolve.`),
          evidence,
          verification: isMove
            ? `Update the new imports on ${context.consumer.label} to take \`${entry.name}\` from \`${movedTo.module}\`.`
            : `Decide whether \`${entry.name}\` should still be exported from \`${entry.module}\`, or repoint the new imports.`,
        }),
      );
    }

    return findings;
  },
};
