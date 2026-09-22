# Research

What was investigated before building, what it changed, and what remains open.
This is a record of conclusions that actually shaped the implementation — not a
survey. Where a finding did not change anything, it says so.

---

## 1. Is the thesis already solved?

**No, but it is squeezed from two sides, and the unclaimed part is narrower
than "semantic conflicts between branches".**

### Already solved, and Hairline should concede it

**Textual conflict resolution.** [Mergiraf](https://mergiraf.org/) (Rust +
tree-sitter, a git merge *driver*) is the current state of the art for
syntax-aware three-way merge. It is good, actively developed, and it is not
what Hairline does: it makes `git merge` produce a better *output*, and never
asks whether that output is correct. The same is true of
[SemanticMerge](https://www.plasticscm.com/semanticmerge) (structural despite
the name, effectively legacy), [Spork](https://github.com/ASSERT-KTH/spork) and
[IntelliMerge](https://dl.acm.org/doi/10.1145/3360596).
[difftastic](https://github.com/Wilfred/difftastic/wiki/Structural-Diffs)
explicitly declines to merge at all.

A cautionary note from that literature: an independent ASE 2024 evaluation
found IntelliMerge produced **50% incorrect merges** against a self-reported
88% precision, and Spork silently produces wrong merges 11% of the time — 3.7×
git's rate. *Structural merge tools have a poor record of self-evaluation.*
This is the main reason Hairline never auto-resolves anything and why the
evaluation harness measures restraint as carefully as detection.

**Type-visible breakage across branches.** A GitHub merge queue runs the
repository's required checks on a *combined* tree — the PR plus the base plus
everything ahead of it in the queue. With `tsc --noEmit` as a required check,
that catches "branch A renames the export, branch B calls the old name" for
free, in every repository that has it configured. **Any pitch resting only on
type-visible breakage loses to a four-word CI config change.**

This finding directly produced `src/evaluation/baseline.ts`: Hairline measures
itself against exactly that baseline, by type-checking the tree
`git merge-tree` produces, over the same fixtures. See
[evaluation.md](./evaluation.md).

**The code-intelligence substrate.** SCIP, scip-typescript, ts-morph and the
TypeScript compiler API are all mature. There is no technical risk here and no
reason to build indexing infrastructure from scratch.

### The mechanism is proven — in a different language, for a narrower problem

**Bucond** (Towqir, Shen, Gulzar & Meng, *ASE 2022*,
[ACM](https://dl.acm.org/doi/abs/10.1145/3551349.3556950)) is Hairline's
closest ancestor and its strongest validation. It models base, left and right
each as a graph, extracts *entity-level edits* per branch (class renaming,
signature change, deletion), and pattern-matches cross-branch edit
combinations against 57 patterns covering 97% of observed build conflicts.

Reported: **100% precision, 95% recall (F1 97%)** on 55 scenarios / 81 real
conflicts; 100% / 88% on a second dataset.

That is the architecture Hairline implements — graph the three revisions,
extract per-branch contract deltas, match combinations across branches — and it
is *validated research*, not a hunch. It was Java-only, build-conflicts-only,
and never productised.

**The lesson that shaped the whole design:** Bucond gets 100% precision because
it scopes down to *decidable* contract violations. The general
"semantic conflict" line, which targets runtime behaviour, does not:

| Work | Technique | Precision | Recall |
|---|---|---|---|
| [de Jesus et al. 2023](https://arxiv.org/abs/2310.04269) | Soot/SVFA dataflow, confluence, override, PDG | **0.43** | 0.60 |
| [Barbosa et al. 2025](https://arxiv.org/pdf/2507.20081) | + pointer analysis | 0.85 | 0.72 |
| [RefFilter 2025](https://arxiv.org/abs/2510.01960) | + refactoring filtering | ~32% FP reduction | slight recall loss |
| [SMAT / unit-test generation](https://arxiv.org/abs/2310.02395) | EvoSuite/Randoop as partial specs | — | **9 of 28 (32%)** |
| [SafeMerge](https://www.cs.utexas.edu/~isil/verified-merge.pdf) (OOPSLA 2018) | Relational verification | verified 75% of 52 scenarios | — |

26 false positives for 20 true positives is a tool that gets switched off in a
week. The 2025 authors say so themselves: it "requires substantial manual
review effort".

**Consequence for Hairline:** every analyzer is scoped to a decidable or
clearly-stated-as-heuristic claim, confidence is a three-valued level attached
to a *named rule*, and the behavioural analyzer deliberately refuses to fire on
a bare body change (see `src/core/analysis/analyzers/behavioral.ts`). The
oldest work in the field, [Horwitz, Prins & Reps,
TOPLAS 1989](https://dl.acm.org/doi/10.1145/73337.73347), established program
dependence graphs as the foundation and was never productised in 35 years;
treating full behavioural semantics as tractable would be repeating that.

### What is genuinely unclaimed

| Gap | Evidence |
|---|---|
| **Three-way (base/A/B) contract analysis** | Every breaking-change detector is **two-way**, one artifact over time: api-extractor, cargo-semver-checks, Revapi, japicmp, [Roseau](https://arxiv.org/abs/2507.17369) (F1 0.99), griffe. The only tool found that maps in-repo call sites, [bobrowsse-tech/breaking-change-detector](https://github.com/bobrowsse-tech/breaking-change-detector), is still two-way, 0 stars, 7 commits. |
| **Semantic conflict detection in TypeScript** | The entire academic corpus is Java (Soot/Jimple/WALA/Spoon). The one JavaScript data point ([ASE 2019, Borba et al.](https://pauloborba.cin.ufpe.br/publication/2019semistructured_merge_in_javascript_systems/2019ASESemistructuredMergeJS.pdf)) is a *negative* result. |
| **Type-invisible contract changes** | Units, nullability conventions, ordering guarantees, defaults, enum meanings, error conventions. Nothing in the surveyed literature or in any 2026 product addresses these. |
| **Pre-queue timing** | Merge queue finds problems at the *head of the queue*, serially, after review and full CI. Crystal (2011) was the only pre-merge attempt and required a full build and test run. |
| **Cross-PR analysis at symbol granularity** | [Trunk.io](https://docs.trunk.io/merge-queue/optimizations/parallel-queues/bazel) does build-*target* granularity, for scheduling rather than correctness. Graphite and Aviator handle human-declared stacks. CodeQL is per-PR. |

### The demand signal is measured, and the gap is explicitly named

- **[AgenticFlict](https://arxiv.org/pdf/2604.03551)** (AIware '26): 142,652
  agentic PRs, 59,412 repositories, **27.67% textual conflict rate**.
  Copilot 15.24%, Cursor 19.75%, Devin 22.85%, Claude Code 25.93%, Codex 31.85%.
  Explicitly out of scope: *"higher-level forms of conflict such as logical
  inconsistencies or post-merge defects"*.
- **[Xu, Subramanian & Karthik](https://arxiv.org/abs/2607.04697v2)** (2026):
  33,596 agent PRs / 2,807 repos. **40.2% of repositories** have exactly
  temporally overlapping agent-PR pairs, accounting for **79.4% of all agent
  PRs**; at ±7 days, 95%. Cross-agent textual conflict rate **41.7%** vs 19.8%
  intra-agent. They decline to measure semantic conflicts and call their
  numbers a *"conservative lower-bound"*.
- **[Brun, Holmes, Ernst & Notkin](https://homes.cs.washington.edu/~mernst/pubs/vc-conflicts-tse2013.pdf)** (*IEEE TSE* 39(10), 2013 — the
  Crystal paper): **over 9% of textually clean merges produced by Git failed to
  build or failed to pass tests.** That 9% is a *lower bound*: it only counts
  what existing test suites happened to catch.
- **[ASE 2024 merge evaluation](https://arxiv.org/abs/2410.09934)** (Schesch,
  Featherman, Yang, Roberts, Ernst) evaluates merge *tools* over 6,045 merges
  from 1,120 repositories, and cites the 9% figure above as motivation. Its
  Figure 2 is the Hairline scenario verbatim.

  *Correction:* earlier revisions of this document attributed the 9% figure to
  the ASE 2024 paper's own dataset. It is the 2013 figure, which that paper
  quotes. Found while verifying citations before publishing them on the site.

Both 2026 flagship agent-PR datasets name semantic conflicts as unmeasured.
That is an unusually clean statement of an open problem.

### Why branch isolation does not close it

The agent-orchestration ecosystem standardised on `git worktree` isolation in
about 18 months — Conductor, Claude Squad, amux, Cursor 2.0's parallel agents,
`agent-traffic-control`'s file-claim protocol. Isolation prevents interference
*during* work. It does nothing about interference *after* merge, and by making
more parallelism practical it makes the integration problem strictly worse.

---

## 2. Parsing and indexing

### TypeScript 7 is the Go port, and its compiler API is gone

`npm view typescript version` reports **7.0.2**. Its `package.json` has no
`main`; `exports["."]` points at `./lib/version.cjs`. Verified locally:

```
$ node -e "const ts=require('typescript'); console.log(typeof ts.createProgram)"
undefined
```

Two exports on TS 7. **2,244 on 5.9.3.** A programmatic API does exist under
`typescript/unstable/sync`, exposing `Program` and `Checker` — but it is an
**RPC client to a Go binary**, explicitly marked unstable, snapshot/LSP-shaped
rather than `createProgram`-shaped, and riddled with array-batching overloads
because every checker call is a round trip. TS 7 also removed
`moduleResolution: "node"` outright.

**Decision: pin `typescript@5.9.3`** ([ADR-0002](./decisions.md)).

### tree-sitter is slower than TypeScript's own parser, and parsing is not the cost

Measured on a 51-file / 1,339-LOC TypeScript project:

| Operation | Time |
|---|---|
| `ts.createProgram` | 54–57 ms |
| + full typecheck, `skipLibCheck: false` | 219–275 ms |
| + full typecheck, `skipLibCheck: true` | **75–79 ms** |
| `ts.createSourceFile` + `forEachChild`, parse only | **4.5–6.6 ms** (14,244 nodes) |
| tree-sitter parse + full walk | 9.6–9.8 ms (26,920 nodes) |

tree-sitter is **~2× slower** here, because it builds a concrete syntax tree
including punctuation. Parsing is ~2% of indexing cost; the type checker is
~95%. `skipLibCheck: true` is the real lever — a **3× reduction**, and it is
set unconditionally in `program.ts`.

This settles the parser question: tree-sitter buys nothing on speed and costs
every type, signature and cross-file resolution — the things the graph is made
of. ts-morph was also rejected: it wraps the same API, adds a mutation layer
Hairline does not need, and pins its own TypeScript version, which fights
multi-revision work.

### Reference resolution: walk every identifier, and unaliasing is mandatory

Bucketing raw `checker.getSymbolAtLocation` results by reference equality
fragments one re-exported function into **five** symbols. After
`getAliasedSymbol`, all 11 occurrences collapse into one — including a renamed
import (`g2` → `greet`). Without unaliasing, "find all references" under-reports
by ~80% on a re-exported symbol.

Two load-bearing details, both implemented in `extract.ts`:
`getAliasedSymbol` **throws** rather than returning `undefined` on a
non-alias, and alias chains can cycle through re-export loops — hence the
`try/catch` and the `MAX_ALIAS_HOPS` guard.

Cost of the whole-program identifier walk: **~3 ms for 5,027 identifiers**,
against ~136 ms to build and check the program. ~2% of indexing. This is why
Hairline does not use `LanguageService.findReferences`, which is designed for
the interactive single-symbol case and is O(symbols × files).

Symbol objects are interned **within one `Program`** and compare reliably by
reference — but not *across* programs, which is precisely why cross-revision
identity needs its own encoding.

### Symbol identity: SCIP-inspired, deliberately simpler

The [SCIP symbol format](https://github.com/sourcegraph/scip/blob/main/docs/scip.md)
is the mature answer, and real `scip-typescript` output looks like:

```
scip-typescript npm scip-demo 1.2.3 src/`types.ts`/User#          <- type
scip-typescript npm scip-demo 1.2.3 src/`types.ts`/User#id.       <- term
scip-typescript npm scip-demo 1.2.3 src/`types.ts`/greet().       <- method
```

Two findings that carried over into `src/core/model/ids.ts`:

- **SCIP embeds the package version.** A `package.json` version bump rewrites
  every symbol in the repository and the diff shows 100% churn. Any adoption
  must neutralise that field for intra-repo symbols.
- **`local N` symbols are document-scoped and not stable across revisions.**
  Never diff on them. Hairline instead gives locals real nested paths
  (`summary.user`) and classifies unmodelled locals separately from failures.

Hairline uses its own simpler encoding ([ADR-0004](./decisions.md)) because it
only needs identity stable *within one repository across revisions*, not across
packages and indexers. It does carry SCIP's overload disambiguator, without
which overloaded methods collide.

**LSIF is dead** — Sourcegraph 4.6 removed read support; all `lsif-*` indexers
are deprecated in favour of `scip-*`. **stack-graphs was archived read-only on
2025-09-09**, so it must not be built on. **Kythe** and **Glean** are
Bazel-shaped and ops-heavy respectively.

### Multi-revision indexing: a virtual compiler host, not worktrees

Verified: a `ts.Program` built from a pure in-memory map, with `getSourceFile`
and friends backed by `git cat-file`, type-checks fully across file boundaries
— including a `as const` literal type propagated across two file hops. Indexing
`main` while HEAD was on `feature` returned `main`'s values, proving it reads
the revision rather than the working tree.

`git worktree` was measured and rejected. It is fast (0.02 s add), but **has no
`node_modules`**, which is fatal:

```
=== worktree WITHOUT node_modules ===
src/a.ts(1,19): error TS2307: Cannot find module 'zod'.   exit=2
=== same worktree WITH symlinked node_modules ===         exit=0
```

Symlinking works but pins every revision to one install and can confuse
`realpath`/`preserveSymlinks` semantics. The virtual host needs no filesystem
mutation, cannot leave orphaned worktrees on crash, and lets N revisions be
indexed concurrently in one process. See [ADR-0005](./decisions.md).

**Three gotchas, all of which bit during implementation:**

1. **`lib.d.ts` cannot be virtualised.** `getDefaultLibFileName` must return a
   real path. 63 lib files load per program.
2. **`getTypeOfSymbolAtLocation` silently returns `any` for type-only
   symbols.** Interfaces and type aliases need
   `getDeclaredTypeOfSymbol`. Easy to ship a broken graph without noticing —
   handled by `isTypeDeclaration` in `contracts.ts`.
3. **`node_modules` is gitignored**, so it is not in any revision's tree and
   must come from disk. This silently assumes installed dependencies match the
   revision being analysed; `run.ts` emits a diagnostic when a branch changes
   `package.json`.

A fourth was found only by running Hairline on a real repository: see
"What real-world validation changed" below.

### Git plumbing: shell out

`git merge-tree --write-tree` (git 2.38+) performs a full merge with **zero
working-tree contact**, printing the merged tree oid and using the exit code as
the answer — 0 clean, 1 conflicted, with the tree oid still produced. Verified
on git 2.50.1. This is what lets Hairline both prove "git merges these cleanly"
and *index the hypothetical merge result* for the baseline comparison.

- **isomorphic-git** (55 packages, 8.8 MB) has **no `merge-tree` equivalent**;
  its `merge()` is working-directory-oriented. Its value is browser support,
  which Hairline does not need.
- **nodegit** is a confirmed dead end — install fails outright on Node 24 /
  macOS arm64, shipping a `node-pre-gyp` deprecated years ago.

`git cat-file --batch` over one process is used for blob reads; a process spawn
per blob dominates runtime at any real scale.

---

## 3. What real-world validation changed

Running Hairline against its own 8,600-LOC source tree found a bug nothing in
the fixture corpus could have: the compiler host's `fileExists` consulted the
disk for `node_modules` while `readFile` did not, so the host claimed every
dependency file existed and then refused to produce it.

Nothing crashed. Nothing was reported. Every dependency type silently degraded
to `any`, and reference resolution sat at **70%** — which Hairline then
reported as a resolution *warning* without anyone being able to tell why.
After the fix: **97.9%**, with unresolved references dropping from 1,606 to 164.

This is the failure mode the whole diagnostics system exists to prevent, and it
still got through, because the tool was only ever run on fixtures whose
dependencies were trivial. Two changes came out of it:

1. `tests/unit/program-host.test.ts` pins dependency resolution, `@types`
   discovery, and that dependency types actually reach extracted contracts.
2. Reference classification became four-way — `resolved`, `external`, `local`,
   `unresolved` — because the old two-way count conflated "declared in
   `lib.es5.d.ts`" with "could not resolve", making a healthy repository look
   30% unanalysed and burying the references that genuinely did not bind.

---

## 4. Open questions

- **Precision outside the corpus is unmeasured.** 100% on 18 hand-built
  fixtures is a statement about the fixtures. See
  [evaluation.md](./evaluation.md#what-these-numbers-do-not-say).
- **Overload sets are not matched across revisions.** Which overload
  corresponds to which is a real problem; today only the count delta is
  recorded, and the first signature is compared in detail.
- **Dynamic boundaries remain invisible**: DI containers, event buses,
  string-keyed routes, config schemas. This is simultaneously where the
  residual value lives and where static resolution fails.
- **Whether the literal-set analyzer's medium tier holds up on real
  repositories.** It is the differentiating rule and the least validated.
- **Whether `local N`-style unmodelled bindings (destructuring, catch
  parameters) should get identities.** They currently cannot participate in
  interactions at all.
