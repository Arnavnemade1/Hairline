import { git, gitBuffer } from './exec.ts';
import type { ModulePath } from '../core/model/ids.ts';

export interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly size: number;
  readonly path: ModulePath;
}

export interface MergeTreeResult {
  /** True when git can merge the two revisions with no textual conflict. */
  readonly clean: boolean;
  /** Oid of the merged tree. Present even when conflicted (with conflict markers). */
  readonly treeOid?: string;
  readonly conflictedPaths: readonly ModulePath[];
  readonly messages: readonly string[];
}

/** Regular file. Anything else (symlink, gitlink, submodule) is not source we will read. */
const MODE_BLOB = '100644';
const MODE_BLOB_EXEC = '100755';

/**
 * Read-only access to git object storage.
 *
 * Every operation addresses objects directly, so nothing here ever touches
 * the working tree, changes HEAD, or creates commits. That is a deliberate
 * safety property: Hairline must be usable on a repository someone is
 * actively working in, and must never be able to lose their work.
 */
export class GitRepository {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(cwd: string): Promise<GitRepository> {
    const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
    return new GitRepository(stdout.trim());
  }

  /** Resolve a branch, tag, or oid to a full commit oid. */
  async resolve(revision: string): Promise<string> {
    const { stdout } = await git(this.root, ['rev-parse', '--verify', `${revision}^{commit}`]);
    return stdout.trim();
  }

  async tryResolve(revision: string): Promise<string | undefined> {
    const result = await git(this.root, ['rev-parse', '--verify', `${revision}^{commit}`], {
      allowFailure: true,
    });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * Best common ancestor of two or more revisions.
   *
   * With more than two revisions git returns the ancestor of the whole set,
   * which is what n-way analysis wants: every branch's changes are measured
   * against one shared origin.
   */
  async mergeBase(revisions: readonly string[]): Promise<string> {
    if (revisions.length === 0) throw new Error('mergeBase requires at least one revision');
    if (revisions.length === 1) return this.resolve(revisions[0]!);
    const { stdout } = await git(this.root, ['merge-base', '--octopus', ...revisions]);
    return stdout.trim();
  }

  async shortOid(oid: string): Promise<string> {
    const { stdout } = await git(this.root, ['rev-parse', '--short', oid]);
    return stdout.trim();
  }

  /** Raw `git log` access, for callers that need a specific format. */
  async log(args: readonly string[]): Promise<{ stdout: string }> {
    const { stdout } = await git(this.root, ['log', ...args]);
    return { stdout };
  }

  async commitSubject(revision: string): Promise<string> {
    const { stdout } = await git(this.root, ['log', '-1', '--format=%s', revision]);
    return stdout.trim();
  }

  /**
   * Every regular file reachable from a revision's tree.
   *
   * `-l` asks for blob sizes, which lets oversized files be skipped before
   * their contents are ever read. In a partial clone (`--filter=blob:none`,
   * which CI uses routinely) the blobs are not present, so asking for sizes
   * forces a network fetch that is slow at best and fails outright when the
   * remote is unreachable. Falling back to a size-free listing keeps Hairline
   * working there: the size cap is then enforced after the read instead of
   * before it, which costs memory on a pathological file but never silently
   * skips one.
   */
  async listTree(revision: string): Promise<TreeEntry[]> {
    let sized = true;
    let result = await git(
      this.root,
      ['ls-tree', '-r', '-l', '-z', '--full-tree', revision],
      { allowFailure: true },
    );
    if (result.code !== 0) {
      sized = false;
      result = await git(this.root, ['ls-tree', '-r', '-z', '--full-tree', revision]);
    }
    const { stdout } = result;
    const entries: TreeEntry[] = [];
    for (const record of stdout.split('\0')) {
      if (record === '') continue;
      // "<mode> <type> <oid>[ <size>]\t<path>"
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(/\s+/);
      const path = record.slice(tab + 1);
      const mode = meta[0];
      const oid = meta[2];
      if (!mode || !oid) continue;
      if (mode !== MODE_BLOB && mode !== MODE_BLOB_EXEC) continue;
      // An unknown size must not read as zero-and-therefore-fine; when sizes
      // are unavailable every entry is admitted and capped after reading.
      const size = sized ? Number(meta[3]) : Number.NaN;
      entries.push({ mode, oid, size: Number.isFinite(size) ? size : Number.NaN, path });
    }
    return entries;
  }

  /** Files that differ between two revisions, with their status letters. */
  async changedFiles(
    from: string,
    to: string,
  ): Promise<Array<{ status: string; path: ModulePath; previousPath?: ModulePath }>> {
    const { stdout } = await git(this.root, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      from,
      to,
    ]);
    const fields = stdout.split('\0').filter((f) => f !== '');
    const out: Array<{ status: string; path: ModulePath; previousPath?: ModulePath }> = [];
    for (let i = 0; i < fields.length; ) {
      const status = fields[i]!;
      if (status.startsWith('R') || status.startsWith('C')) {
        const previousPath = fields[i + 1];
        const path = fields[i + 2];
        if (path === undefined || previousPath === undefined) break;
        out.push({ status, path, previousPath });
        i += 3;
      } else {
        const path = fields[i + 1];
        if (path === undefined) break;
        out.push({ status, path });
        i += 2;
      }
    }
    return out;
  }

  /**
   * Read many blobs in one git process.
   *
   * `cat-file --batch` streams `<oid> blob <size>\n<bytes>\n` per request.
   * Doing this per file would cost a process spawn per file, which dominates
   * indexing time on anything larger than a fixture.
   */
  async readBlobs(oids: readonly string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    if (oids.length === 0) return out;
    const unique = [...new Set(oids)];
    const { stdout } = await gitBuffer(this.root, ['cat-file', '--batch'], unique.join('\n') + '\n');

    let offset = 0;
    while (offset < stdout.length) {
      const newline = stdout.indexOf(0x0a, offset);
      if (newline < 0) break;
      const header = stdout.subarray(offset, newline).toString('utf8');
      offset = newline + 1;
      const parts = header.split(' ');
      if (parts.length < 3) {
        // "<oid> missing" — skip, leaving the entry absent from the map.
        continue;
      }
      const oid = parts[0]!;
      const size = Number(parts[2]);
      if (!Number.isFinite(size)) break;
      out.set(oid, stdout.subarray(offset, offset + size));
      offset += size + 1; // trailing newline
    }
    return out;
  }

  /**
   * Ask git whether two revisions merge cleanly, without creating a commit,
   * touching the working tree, or moving HEAD.
   *
   * Exit code 0 means clean; 1 means conflicts, and the tree oid still comes
   * back (with conflict markers written into the blobs).
   */
  async mergeTree(a: string, b: string): Promise<MergeTreeResult> {
    const result = await git(this.root, ['merge-tree', '--write-tree', '--name-only', a, b], {
      allowFailure: true,
    });
    if (result.code !== 0 && result.code !== 1) {
      return {
        clean: false,
        conflictedPaths: [],
        messages: [result.stderr.trim() || `git merge-tree exited ${result.code}`],
      };
    }
    const lines = result.stdout.split('\n');
    const treeOid = lines[0]?.trim() || undefined;
    const clean = result.code === 0;
    if (clean) {
      return treeOid
        ? { clean: true, treeOid, conflictedPaths: [], messages: [] }
        : { clean: true, conflictedPaths: [], messages: [] };
    }
    const conflictedPaths: ModulePath[] = [];
    const messages: string[] = [];
    let inMessages = false;
    for (const line of lines.slice(1)) {
      if (line === '') {
        inMessages = true;
        continue;
      }
      if (inMessages) messages.push(line);
      else conflictedPaths.push(line);
    }
    return treeOid
      ? { clean: false, treeOid, conflictedPaths, messages }
      : { clean: false, conflictedPaths, messages };
  }

  /** True when `ancestor` is reachable from `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await git(this.root, ['merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true,
    });
    return result.code === 0;
  }
}
