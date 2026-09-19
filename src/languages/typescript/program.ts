import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import type { ModulePath } from '../../core/model/ids.ts';
import type { RepositorySnapshot } from '../../core/model/snapshot.ts';
import type { AnalysisDiagnostic } from '../../core/model/diagnostics.ts';

/**
 * All snapshot files live under this synthetic root.
 *
 * Using a path that cannot exist on disk means a bug in path handling
 * surfaces as "file not found" rather than as Hairline silently reading the
 * developer's working tree — which would mix revisions and produce findings
 * that cannot be reproduced.
 */
export const VIRTUAL_ROOT = '/__hairline__';

export interface ProgramOptions {
  /**
   * Absolute path to a directory whose `node_modules` may be consulted for
   * dependency type declarations. Read-only, and never used for repository
   * source. See `docs/threat-model.md` for why this is opt-in.
   */
  readonly nodeModulesRoot?: string;
  /** Overrides applied after the snapshot's own tsconfig is read. */
  readonly compilerOptions?: ts.CompilerOptions;
}

export interface SnapshotProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly diagnostics: readonly AnalysisDiagnostic[];
  toVirtual(modulePath: ModulePath): string;
  fromVirtual(fileName: string): ModulePath | undefined;
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // Bundler resolution is the most permissive of the modern modes: it
    // accepts extensionless specifiers, `./x.js` pointing at `x.ts`, and
    // directory index files. Hairline is not compiling anything, so being
    // able to resolve the most specifier styles matters more than matching
    // any single project's emit semantics exactly.
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowJs: true,
    checkJs: false,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
    // Repository code is never executed, but it is also never emitted, so
    // isolatedModules keeps the checker from doing cross-file emit work.
    isolatedModules: false,
  };
}

/**
 * Compiler options a snapshot's own tsconfig is allowed to influence.
 *
 * Everything else is fixed by Hairline. Honouring a repository's `paths` and
 * `jsx` settings materially improves resolution; honouring its `noEmit: false`
 * or `outDir` would only create opportunities to write files.
 */
const HONOURED_OPTIONS = [
  'baseUrl',
  'paths',
  'jsx',
  'jsxImportSource',
  'target',
  'lib',
  'experimentalDecorators',
  'useDefineForClassFields',
  'allowSyntheticDefaultImports',
  'esModuleInterop',
  'strict',
  'strictNullChecks',
  'exactOptionalPropertyTypes',
  'noUncheckedIndexedAccess',
] as const;

function readSnapshotCompilerOptions(
  snapshot: RepositorySnapshot,
  diagnostics: AnalysisDiagnostic[],
): ts.CompilerOptions {
  const candidates = ['tsconfig.json', 'tsconfig.base.json'];
  for (const candidate of candidates) {
    const text = snapshot.read(candidate);
    if (text === undefined) continue;
    const parsed = ts.parseConfigFileTextToJson(candidate, text);
    if (parsed.error || !parsed.config) {
      diagnostics.push({
        code: 'unsupported-construct',
        severity: 'info',
        message: `Could not parse ${candidate}; falling back to Hairline defaults`,
        module: candidate,
      });
      continue;
    }
    const raw = (parsed.config as { compilerOptions?: Record<string, unknown> }).compilerOptions;
    if (!raw) continue;
    const converted = ts.convertCompilerOptionsFromJson(raw, VIRTUAL_ROOT, candidate);
    const picked: ts.CompilerOptions = {};
    for (const key of HONOURED_OPTIONS) {
      const value = (converted.options as Record<string, unknown>)[key];
      if (value !== undefined) (picked as Record<string, unknown>)[key] = value;
    }
    if (picked.baseUrl !== undefined) picked.baseUrl = VIRTUAL_ROOT;
    return picked;
  }
  return {};
}

/**
 * Build a `ts.Program` whose file system is a snapshot rather than the disk.
 *
 * This is the mechanism that lets Hairline analyse several revisions in one
 * process without checking anything out, without a working tree, and without
 * the revisions being able to see each other.
 */
export function createSnapshotProgram(
  snapshot: RepositorySnapshot,
  options: ProgramOptions = {},
): SnapshotProgram {
  const diagnostics: AnalysisDiagnostic[] = [];
  const toVirtual = (modulePath: ModulePath): string => `${VIRTUAL_ROOT}/${modulePath}`;
  const fromVirtual = (fileName: string): ModulePath | undefined =>
    fileName.startsWith(`${VIRTUAL_ROOT}/`) ? fileName.slice(VIRTUAL_ROOT.length + 1) : undefined;

  const libDirectory = path.dirname(ts.sys.getExecutingFilePath());
  const nodeModulesRoot = options.nodeModulesRoot
    ? path.resolve(options.nodeModulesRoot)
    : undefined;

  /**
   * Disk reads are confined to two directories: TypeScript's own `lib.*.d.ts`
   * files, and (when explicitly enabled) the project's `node_modules`. A path
   * outside both is refused even if the compiler asks for it.
   */
  const diskPathFor = (fileName: string): string | undefined => {
    const resolved = path.resolve(fileName);
    if (resolved.startsWith(libDirectory + path.sep)) return resolved;
    if (nodeModulesRoot) {
      const modules = path.join(nodeModulesRoot, 'node_modules');
      if (resolved.startsWith(modules + path.sep)) return resolved;
      // Module resolution probes `<dir>/node_modules/...` walking upwards; map
      // those probes onto the one node_modules directory we allow. The
      // directory itself must map too, not only paths beneath it: resolution
      // asks `directoryExists('<root>/node_modules')` first and stops there if
      // the answer is no.
      const marker = `${VIRTUAL_ROOT}/`;
      if (fileName.startsWith(marker)) {
        const relative = fileName.slice(marker.length);
        if (relative === 'node_modules' || relative.startsWith('node_modules/')) {
          return path.join(nodeModulesRoot, relative);
        }
      }
    }
    return undefined;
  };

  const readDisk = (fileName: string): string | undefined => {
    const diskPath = diskPathFor(fileName);
    if (!diskPath) return undefined;
    try {
      return fs.readFileSync(diskPath, 'utf8');
    } catch {
      return undefined;
    }
  };

  const snapshotPaths = new Set(snapshot.files.map((f) => f.path));
  const sourceCache = new Map<string, ts.SourceFile | undefined>();

  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersionOrOptions) {
      const cached = sourceCache.get(fileName);
      if (cached !== undefined || sourceCache.has(fileName)) return cached;
      // A path under the synthetic root is usually snapshot content, but
      // `node_modules` lives under it too and is served from disk. Falling
      // through on a miss is essential: `fileExists` consults disk, so
      // answering `undefined` here would make the host claim a file exists
      // and then refuse to produce it, and module resolution would silently
      // fail for every dependency.
      const modulePath = fromVirtual(fileName);
      const text =
        (modulePath !== undefined ? snapshot.read(modulePath) : undefined) ?? readDisk(fileName);
      let file: ts.SourceFile | undefined;
      if (text !== undefined) {
        file = ts.createSourceFile(
          fileName,
          text,
          languageVersionOrOptions,
          /* setParentNodes */ true,
        );
      }
      sourceCache.set(fileName, file);
      return file;
    },
    getDefaultLibFileName: (compilerOptions) =>
      path.join(libDirectory, ts.getDefaultLibFileName(compilerOptions)),
    getDefaultLibLocation: () => libDirectory,
    // Hairline never emits. Swallowing writes rather than omitting the method
    // means an accidental emit path cannot touch the filesystem.
    writeFile: () => undefined,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists(fileName) {
      const modulePath = fromVirtual(fileName);
      if (modulePath !== undefined && snapshotPaths.has(modulePath)) return true;
      const diskPath = diskPathFor(fileName);
      if (!diskPath) return false;
      try {
        return fs.statSync(diskPath).isFile();
      } catch {
        return false;
      }
    },
    readFile(fileName) {
      const modulePath = fromVirtual(fileName);
      const fromSnapshot = modulePath !== undefined ? snapshot.read(modulePath) : undefined;
      return fromSnapshot ?? readDisk(fileName);
    },
    directoryExists(directoryName) {
      const modulePath = fromVirtual(directoryName);
      if (modulePath !== undefined) {
        const prefix = modulePath === '' ? '' : `${modulePath}/`;
        for (const file of snapshotPaths) if (file.startsWith(prefix)) return true;
      }
      const diskPath = diskPathFor(directoryName);
      if (!diskPath) return false;
      try {
        return fs.statSync(diskPath).isDirectory();
      } catch {
        return false;
      }
    },
    /**
     * Subdirectories of a directory.
     *
     * The disk branch is load-bearing rather than a convenience: TypeScript
     * discovers ambient type packages by *listing* `node_modules/@types`. A
     * host that answers `[]` there silently loses `@types/node`, every
     * `process` and `node:*` reference becomes an error, and the resulting
     * cascade of `any` costs a large share of reference resolution across the
     * whole snapshot — with no diagnostic pointing at the cause.
     */
    getDirectories(directoryName) {
      const modulePath = fromVirtual(directoryName);
      if (modulePath !== undefined && !modulePath.startsWith('node_modules')) {
        const prefix = modulePath === '' ? '' : `${modulePath}/`;
        const names = new Set<string>();
        for (const file of snapshotPaths) {
          if (!file.startsWith(prefix)) continue;
          const rest = file.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash > 0) names.add(rest.slice(0, slash));
        }
        return [...names];
      }
      const diskPath = diskPathFor(directoryName);
      if (!diskPath) return [];
      try {
        return fs
          .readdirSync(diskPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    realpath: (fileName) => fileName,
  };

  const compilerOptions = Object.assign(
    defaultCompilerOptions(),
    readSnapshotCompilerOptions(snapshot, diagnostics),
    options.compilerOptions,
  );
  // Non-negotiable, whatever the repository's tsconfig says.
  compilerOptions.noEmit = true;
  compilerOptions.skipLibCheck = true;
  compilerOptions.declaration = false;
  compilerOptions.composite = false;
  compilerOptions.incremental = false;
  compilerOptions.baseUrl = VIRTUAL_ROOT;
  // Emit-related options are removed outright rather than set to `undefined`,
  // so no code path can observe a key that claims an output location.
  for (const key of ['outDir', 'declarationDir', 'tsBuildInfoFile', 'rootDir'] as const) {
    delete (compilerOptions as Record<string, unknown>)[key];
  }

  const rootNames = snapshot.files
    .filter((f) => f.language === 'ts')
    .map((f) => toVirtual(f.path));

  const program = ts.createProgram({ rootNames, options: compilerOptions, host });
  const sourceFiles = program
    .getSourceFiles()
    .filter((f) => fromVirtual(f.fileName) !== undefined && !f.isDeclarationFile);

  for (const file of sourceFiles) {
    const parseDiagnostics = program.getSyntacticDiagnostics(file);
    if (parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0]!;
      diagnostics.push({
        code: 'parse-failed',
        severity: 'warning',
        message: `Syntax error: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`,
        module: fromVirtual(file.fileName)!,
        ...(snapshot.revision ? { revision: snapshot.revision } : {}),
      });
    }
  }

  return { program, checker: program.getTypeChecker(), sourceFiles, diagnostics, toVirtual, fromVirtual };
}

/**
 * Type errors for a snapshot, as `tsc --noEmit` would report them.
 *
 * Used by the evaluation harness to measure Hairline against the baseline the
 * prior-art research identified as the real incumbent: running the type
 * checker on the speculative merge result. See docs/evaluation.md.
 */
export function typeErrorsFor(
  snapshotProgram: SnapshotProgram,
): Array<{ module: ModulePath; line: number; message: string; code: number }> {
  const out: Array<{ module: ModulePath; line: number; message: string; code: number }> = [];
  for (const file of snapshotProgram.sourceFiles) {
    const modulePath = snapshotProgram.fromVirtual(file.fileName);
    if (modulePath === undefined) continue;
    const fileDiagnostics = [
      ...snapshotProgram.program.getSemanticDiagnostics(file),
      ...snapshotProgram.program.getSyntacticDiagnostics(file),
    ];
    for (const diagnostic of fileDiagnostics) {
      const position = diagnostic.start ?? 0;
      const { line } = file.getLineAndCharacterOfPosition(position);
      out.push({
        module: modulePath,
        line: line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        code: diagnostic.code,
      });
    }
  }
  return out;
}
