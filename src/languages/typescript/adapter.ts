import type { LanguageAdapter, AdapterCapabilities, IndexOptions } from '../adapter.ts';
import type { RepositorySnapshot, SemanticIndex } from '../../core/model/snapshot.ts';
import type { AnalysisDiagnostic, Coverage } from '../../core/model/diagnostics.ts';
import { createSnapshotProgram } from './program.ts';
import { extract } from './extract.ts';

const CAPABILITIES: AdapterCapabilities = {
  parse: true,
  symbols: true,
  references: true,
  types: true,
  signatures: true,
  literalSets: true,
  modules: true,
};

/**
 * TypeScript and JavaScript, via the TypeScript compiler API.
 *
 * JavaScript files are indexed with the same machinery; they simply yield
 * weaker contracts, which the diagnostics record rather than hide. That is a
 * feature for Hairline's purposes: a JS consumer of a changed contract is
 * exactly the case a type checker cannot see.
 */
export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = 'ts' as const;
  readonly displayName = 'TypeScript / JavaScript';
  readonly capabilities = CAPABILITIES;

  index(snapshot: RepositorySnapshot, options: IndexOptions = {}): SemanticIndex {
    const snapshotProgram = createSnapshotProgram(snapshot, {
      ...(options.nodeModulesRoot !== undefined
        ? { nodeModulesRoot: options.nodeModulesRoot }
        : {}),
    });
    const result = extract(snapshotProgram, options.contractScope, options.contractBudgetMs);

    const diagnostics: AnalysisDiagnostic[] = [
      ...snapshotProgram.diagnostics,
      ...result.diagnostics,
    ];

    const indexable = snapshot.files.filter((f) => f.language === 'ts');
    const indexed = snapshotProgram.sourceFiles.length;
    const failed = diagnostics.filter((d) => d.code === 'parse-failed').length;

    const coverage: Coverage = {
      filesDiscovered: snapshot.files.length,
      filesIndexed: indexed,
      filesSkipped: snapshot.files.length - indexable.length,
      filesFailed: failed,
      symbolsIndexed: result.symbols.size,
      referencesResolved: result.resolvedReferenceCount,
      referencesExternal: result.externalReferenceCount,
      referencesLocal: result.localReferenceCount,
      referencesUnresolved: result.unresolvedReferenceCount,
      typeInformation: true,
    };

    return {
      snapshot,
      language: 'ts',
      symbols: result.symbols,
      references: result.references,
      imports: result.imports,
      exports: result.exports,
      literals: result.literals,
      diagnostics,
      coverage,
    };
  }
}
