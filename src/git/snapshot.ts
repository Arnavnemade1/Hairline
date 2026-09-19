import { createHash } from 'node:crypto';
import type { GitRepository } from './repository.ts';
import type { LanguageId, ModulePath } from '../core/model/ids.ts';
import type { FileRecord, RepositorySnapshot } from '../core/model/snapshot.ts';
import type { AnalysisDiagnostic } from '../core/model/diagnostics.ts';

/**
 * Limits applied when turning a revision into a snapshot.
 *
 * Repository content is untrusted input (docs/threat-model.md). Every limit
 * here exists because some repository somewhere will hit it, and the failure
 * mode must be a diagnostic rather than an exhausted heap.
 */
export interface SnapshotPolicy {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  /** Path prefixes never indexed, matched against repo-relative POSIX paths. */
  readonly excludedDirectories: readonly string[];
  /** Extensions that map to a language adapter. */
  readonly extensions: Readonly<Record<string, LanguageId>>;
}

export const DEFAULT_POLICY: SnapshotPolicy = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFiles: 50_000,
  excludedDirectories: [
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    'out/',
    'coverage/',
    '.next/',
    'vendor/',
    '.yarn/',
  ],
  extensions: {
    '.ts': 'ts',
    '.tsx': 'ts',
    '.mts': 'ts',
    '.cts': 'ts',
    '.js': 'ts',
    '.jsx': 'ts',
    '.mjs': 'ts',
    '.cjs': 'ts',
  },
};

/**
 * Reject paths that could escape the repository root if they were ever joined
 * onto a filesystem path. Hairline reads from git objects and never does that,
 * but an adapter or a cache might, so the invariant is enforced at the source.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  if (path.includes('\0')) return false;
  const segments = path.split('/');
  return !segments.some((s) => s === '' || s === '.' || s === '..');
}

export function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot) : '';
}

/** A NUL byte in the first 8 KiB is the same heuristic git itself uses. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

export interface SnapshotBuildResult {
  readonly snapshot: RepositorySnapshot;
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

/**
 * Materialise one revision as an immutable snapshot of indexable source files.
 *
 * Only files an adapter could plausibly read are loaded; everything else is
 * counted and dropped. Content is held in memory because indexing needs it
 * all anyway, and because holding it means the working tree is never involved.
 */
export async function buildSnapshot(
  repo: GitRepository,
  revision: string,
  label: string,
  policy: SnapshotPolicy = DEFAULT_POLICY,
): Promise<SnapshotBuildResult> {
  const oid = await repo.resolve(revision);
  const entries = await repo.listTree(oid);
  const diagnostics: AnalysisDiagnostic[] = [];

  const candidates: Array<{ path: ModulePath; oid: string; size: number; language: LanguageId }> = [];
  for (const entry of entries) {
    if (!isSafeRepoPath(entry.path)) {
      diagnostics.push({
        code: 'file-skipped',
        severity: 'warning',
        message: `Path rejected as unsafe: ${JSON.stringify(entry.path)}`,
        module: entry.path,
        revision: oid,
      });
      continue;
    }
    if (policy.excludedDirectories.some((d) => entry.path.startsWith(d) || entry.path.includes(`/${d}`))) {
      continue;
    }
    const language = policy.extensions[extensionOf(entry.path)];
    if (!language) continue;
    if (entry.size > policy.maxFileBytes) {
      diagnostics.push({
        code: 'file-skipped',
        severity: 'warning',
        message: `File exceeds ${policy.maxFileBytes} byte limit (${entry.size} bytes); not indexed`,
        module: entry.path,
        revision: oid,
      });
      continue;
    }
    candidates.push({ path: entry.path, oid: entry.oid, size: entry.size, language });
  }

  if (candidates.length > policy.maxFiles) {
    diagnostics.push({
      code: 'limit-exceeded',
      severity: 'error',
      message: `Snapshot has ${candidates.length} indexable files, above the ${policy.maxFiles} limit; truncated`,
      revision: oid,
    });
    candidates.length = policy.maxFiles;
  }

  const blobs = await repo.readBlobs(candidates.map((c) => c.oid));
  const contents = new Map<ModulePath, string>();
  const files: FileRecord[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    const buffer = blobs.get(candidate.oid);
    if (!buffer) {
      diagnostics.push({
        code: 'file-skipped',
        severity: 'warning',
        message: 'Blob could not be read from the object database',
        module: candidate.path,
        revision: oid,
      });
      continue;
    }
    if (looksBinary(buffer)) {
      diagnostics.push({
        code: 'file-skipped',
        severity: 'info',
        message: 'File contains NUL bytes and was treated as binary',
        module: candidate.path,
        revision: oid,
      });
      continue;
    }
    totalBytes += buffer.length;
    if (totalBytes > policy.maxTotalBytes) {
      diagnostics.push({
        code: 'limit-exceeded',
        severity: 'error',
        message: `Snapshot exceeded ${policy.maxTotalBytes} total bytes; remaining files not indexed`,
        revision: oid,
      });
      break;
    }
    contents.set(candidate.path, buffer.toString('utf8'));
    files.push({
      path: candidate.path,
      contentHash: candidate.oid,
      byteLength: buffer.length,
      language: candidate.language,
    });
  }

  return {
    snapshot: {
      label,
      revision: oid,
      files,
      read: (path) => contents.get(path),
    },
    diagnostics,
  };
}

/**
 * A snapshot backed by a plain object, for unit tests and for indexing
 * synthesised trees (such as the result of a speculative merge).
 */
export function memorySnapshot(
  label: string,
  files: Readonly<Record<ModulePath, string>>,
  policy: SnapshotPolicy = DEFAULT_POLICY,
): RepositorySnapshot {
  const records: FileRecord[] = [];
  for (const [path, content] of Object.entries(files)) {
    const language = policy.extensions[extensionOf(path)];
    records.push({
      path,
      contentHash: createHash('sha1').update(content).digest('hex'),
      byteLength: Buffer.byteLength(content),
      ...(language ? { language } : {}),
    });
  }
  return {
    label,
    files: records,
    read: (path) => files[path],
  };
}

/** Materialise a bare tree oid (e.g. the output of `merge-tree`) as a snapshot. */
export async function buildSnapshotFromTree(
  repo: GitRepository,
  treeOid: string,
  label: string,
  policy: SnapshotPolicy = DEFAULT_POLICY,
): Promise<SnapshotBuildResult> {
  const entries = await repo.listTree(treeOid);
  const candidates = entries.filter(
    (e) =>
      isSafeRepoPath(e.path) &&
      !policy.excludedDirectories.some((d) => e.path.startsWith(d) || e.path.includes(`/${d}`)) &&
      policy.extensions[extensionOf(e.path)] !== undefined &&
      e.size <= policy.maxFileBytes,
  );
  const blobs = await repo.readBlobs(candidates.map((c) => c.oid));
  const contents = new Map<ModulePath, string>();
  const files: FileRecord[] = [];
  for (const candidate of candidates) {
    const buffer = blobs.get(candidate.oid);
    if (!buffer || looksBinary(buffer)) continue;
    contents.set(candidate.path, buffer.toString('utf8'));
    const language = policy.extensions[extensionOf(candidate.path)];
    files.push({
      path: candidate.path,
      contentHash: candidate.oid,
      byteLength: buffer.length,
      ...(language ? { language } : {}),
    });
  }
  return {
    snapshot: { label, revision: treeOid, files, read: (p) => contents.get(p) },
    diagnostics: [],
  };
}
