# Architecture decisions

Decisions that shaped the implementation, with the evidence behind them.
Entries are append-only; a superseded decision is marked rather than edited.

---

## ADR-0001 — Scope the MVP to decidable contract violations

**Decision.** Detect interactions between *contract* changes and *use sites*,
not behavioural equivalence. Analyzers that cannot decide say so in their
confidence rationale, and the one analyzer that reasons about behaviour refuses
to fire without a value-level signal.

**Context.** "Semantic conflict detection" is a 35-year-old research problem.
The published numbers are poor and the authors say so.

**Options considered.**
1. Full behavioural analysis (dataflow, slicing, relational verification).
2. Generated tests as partial specifications (the SMAT approach).
3. Contract-and-consumer analysis, scoped to what an index can decide.

**Chosen.** Option 3.

**Why.** The precision table in [research.md](./research.md#the-mechanism-is-proven--in-a-different-language-for-a-narrower-problem)
is decisive: the general semantic-conflict line sits at 0.43 precision (20 true
positives against 26 false), reaching 0.85 only with pointer analysis that its
own authors call impractical. Bucond (ASE 2022) reached **100% precision**
doing essentially what Hairline does, and the difference is scope: it targeted
*decidable* build conflicts. Precision is the product for a pre-merge gate;
scope is the lever that buys it.

**Alternatives rejected.** Option 1 does not scale and has never been
productised in 35 years. Option 2 detected 9 of 28 conflicts (32% recall),
bounded entirely by the test generator's coverage, and is slow.

**Consequences.** Hairline cannot detect a pure behaviour change, and says so
rather than guessing. `behavioral-risk` findings are capped at low confidence.
The negative half of the corpus is as large as the positive half.

---

## ADR-0002 — Depend on `typescript@5.9.3`, not the latest release

**Decision.** Pin the exact version `5.9.3`, not `^5.9.0` and not `latest`.

**Context.** `npm view typescript version` reports **7.0.2**, which is the
native Go port.

**Options considered.**
1. `typescript@7` via `typescript/unstable/sync`.
2. `typescript@5.9.x`.
3. tree-sitter, no type checker.

**Chosen.** Option 2, pinned exactly.

**Why.** Verified locally: `require('typescript')` on 7.0.2 yields
`{version, versionMajorMinor}` and nothing else — `typeof ts.createProgram` is
`undefined`. Two exports against 2,244 on 5.9.3. The TS 7 programmatic API
exists but is an RPC client to a Go binary, is explicitly `unstable/`, and is
snapshot/LSP-shaped rather than `createProgram`-shaped.

Pinning exactly rather than with a caret is deliberate: `typeToString` output
is a *comparison key* in the change model, and a patch release that renders a
type differently would register as a contract change on every symbol it
touched. The version is analysis-relevant, not just a dependency.

**Alternatives rejected.** Option 3 was measured: tree-sitter is ~2× *slower*
than `ts.createSourceFile` on the same input, parsing is ~2% of indexing cost,
and it supplies no types, signatures or cross-file resolution.

**Consequences.** Hairline will need a migration when the TS 7 API stabilises.
`src/languages/typescript/program.ts` is the only file that constructs a
program, so the blast radius is one module. TS 7's `unstable/fs`
`createVirtualFileSystem` has a tri-state `readFile` contract that fits this
design well when the time comes.

---

## ADR-0003 — One runtime dependency

**Decision.** `typescript` is the only runtime dependency. `@types/node` is
the only development dependency. Tests run on `node:test`; the CLI parser,
ANSI styling and evaluation harness are written here.

**Context.** The obvious picks would be commander, vitest, zod and picocolors —
all reasonable, all recommended by the research pass.

**Why.** Hairline reads untrusted repositories for a living. Every dependency
is code that runs in that process, and a static analysis tool that pulls in a
supply chain is a poor advertisement for itself. The measured cost of holding
the line is small: `src/cli/args.ts` is ~60 lines against commander's 236 KB,
`src/reporters/style.ts` is ~30 lines against chalk's 88 KB. Node 24 runs
TypeScript test files natively with no loader, no build step and no config,
which removes the strongest argument for vitest.

`npm audit` reports 0 vulnerabilities, and `npm ls --depth=0` is three lines.

**Alternatives rejected.** vitest's snapshot testing and `vi.mock` were the
real temptation, but Hairline's tests run against *actual git repositories*
built by `tests/fixtures/build.ts`, so there is nothing to mock, and snapshots
of findings would be worse than the explicit assertions in
`tests/integration/corpus.test.ts` — a snapshot that silently absorbs a
regression is exactly the failure mode this project cannot afford.

**Consequences.** `erasableSyntaxOnly` is enabled, so no TypeScript `enum`, no
parameter properties, no namespaces with runtime content. This is why
`SymbolKind` and friends are union types rather than enums.

---

## ADR-0004 — A repository-local symbol identity, SCIP-inspired

**Decision.** Encode identity as
`ts:<module>#<dotted.path>@<kind>[~<disambiguator>]`, e.g.
`ts:src/user.ts#User.status@property`. Never derive identity from line or byte
offsets.

**Context.** Cross-revision comparison needs a key that survives reformatting,
line movement, and unrelated edits. SCIP is the mature standard.

**Options considered.**
1. Adopt SCIP symbol strings verbatim.
2. A repository-local encoding inspired by SCIP.
3. Hash of the declaration's text.

**Chosen.** Option 2.

**Why.** SCIP embeds the package *version* in every symbol
(`scip-typescript npm scip-demo 1.2.3 src/...`), so bumping `package.json`
rewrites every symbol in the repository and the diff shows 100% churn. It also
requires backtick-escaping any path containing a `.` — which is every
TypeScript file. Hairline only needs identity stable *within one repository
across revisions*, and the simpler encoding is greppable, appears verbatim in
findings and fixture expectations, and costs nothing to read.

SCIP's method disambiguator **was** adopted: without it, overloaded
declarations collide.

**Alternatives rejected.** Option 3 makes every edit a new symbol, which
defeats the purpose.

**Consequences.** Not interoperable with Sourcegraph tooling. If that becomes
valuable, the encoding is confined to `src/core/model/ids.ts` and a SCIP
emitter can be added alongside. Kinds participate in identity, so changing a
`function Foo` to a `const Foo` reads as a removal plus an addition — which the
`kind-changed` delta and the rename detector exist to describe.

---

## ADR-0005 — A virtual compiler host over git objects, not worktrees

**Decision.** Build each revision's `ts.Program` from a snapshot backed by
`git cat-file`, mounted under the synthetic root `/__hairline__`. Never check
anything out.

**Options considered.**
1. `git worktree add` per revision.
2. A custom `ts.CompilerHost` over git objects.
3. Copy revisions to a temporary directory.

**Chosen.** Option 2.

**Why.** Measured: a worktree has no `node_modules`, and a project importing
`zod` fails with `TS2307` until `node_modules` is symlinked in. The symlink
works but pins every revision to one install and can confuse `realpath` and
`preserveSymlinks` semantics. The virtual host needs no filesystem mutation,
cannot leave orphaned worktrees on crash, indexes N revisions concurrently in
one process, and — verified by test — leaves HEAD and the working tree
untouched, which matters because Hairline is meant to run in a repository
someone is actively working in.

The synthetic root is chosen to be a path that cannot exist on disk, so a bug
in path handling surfaces as "file not found" rather than as Hairline silently
reading the developer's working tree and producing findings that cannot be
reproduced.

**Consequences.** Disk reads are confined to TypeScript's `lib/` and, opt-in,
one `node_modules`. Dependency types therefore come from the *working tree*,
not from the revision — an explicit approximation, with a diagnostic emitted
when a branch changes `package.json`.

This decision has a sharp edge, found only by running Hairline on a real
repository: `fileExists` consulted disk while `readFile` did not, so the host
claimed dependency files existed and then refused to produce them. Every
dependency type degraded to `any`, silently. `tests/unit/program-host.test.ts`
now pins the behaviour.

---

## ADR-0006 — An in-memory graph, not a graph database

**Decision.** `SemanticGraph` is a handful of hash maps built from the flat
index.

**Why.** Every hot question is an adjacency lookup — "who references this
symbol?", "which modules import this one?" — answered in constant time by a
`Map`. Measured on an 8,600-LOC repository: indexing three revisions takes
~1.7 s, of which the graph is a negligible fraction; **analysis itself is
34 ms**. A database would add operational weight, a serialisation boundary and
a second source of truth in exchange for persistence and cross-process queries
the MVP does not use.

**Consequences.** Whole-repository indexing is memory-bound. The snapshot
policy caps file size and count. Revisit if a repository is encountered where
analysis, rather than indexing, is the bottleneck — it is not close today.

---

## ADR-0007 — Only *fresh* use sites count as cross-branch evidence

**Decision.** An interaction is reported only when the consuming branch
*introduced or edited* the use site. Use sites that existed unchanged at the
merge base are excluded.

**Context.** The single most important precision decision in the engine
(`BranchView.freshReferencesTo`).

**Why.** If a use site already existed at the base and branch A broke it, then
**A is broken on its own** — A's own type check or test suite would catch it,
and it is not a cross-branch problem. The premise of the whole product is that
*both branches are green in isolation*, and that can only happen when the
contract change and the use site were invisible to each other. Requiring the
consumer to be new is what makes that precise.

**Evidence.** `tests/fixtures/corpus.ts` contains the discriminating pair:
`negative--signature-changed-and-caller-updated` (new call site, compatible
with the new signature → silent) against
`required-parameter-added-under-new-caller` (new call site, incompatible →
reported). The evaluation harness independently verifies that both branches
type-check alone, so a fixture cannot pass by having a simply-broken branch.

**Consequences.** Hairline will not report a contract change that breaks only
*pre-existing* consumers. That is deliberate — it is the branch author's own
CI's job — but it means Hairline is not a substitute for that CI.

---

## ADR-0008 — Confidence is a level attached to a named rule, not a probability

**Decision.** `ConfidenceLevel` is `high | medium | low`. Each finding carries
a `basis` (a stable rule id) and a `rationale` sentence. The JSON report also
emits `confidenceScore`, a **fixed mapping** of the level, documented as not
being a probability.

**Why.** A number like `0.94` implies a calibrated model. There is no
calibration data, so the number would be decoration with the appearance of
rigour — worse than "high", because it cannot be argued with. Naming the rule
means the evaluation harness can report precision *per rule*, so a rule that
turns out to be unreliable can be found and fixed rather than quietly diluting
trust in everything else.

**Consequences.** Consumers that need to sort numerically can use
`confidenceScore`; the field name and the schema documentation both say what it
is. Adding a genuinely calibrated score later is an additive change.

---

## ADR-0009 — Measure against `tsc` on the merged tree, in the harness

**Decision.** `src/evaluation/baseline.ts` type-checks the tree
`git merge-tree --write-tree` produces, and every fixture declares whether that
baseline `catches` or `misses` it. The declaration is asserted, not assumed.

**Why.** Research identified the real incumbent as a merge queue running
`tsc --noEmit` on the combined tree — free, universal, and already configured
in many repositories. Any evaluation that ignores it would be measuring against
a strawman. Building it in makes the honest question checkable on every run:
*which findings are ones the incumbent already gets?*

**Evidence.** Current corpus: 6 fixtures caught by both, **4 caught only by
Hairline** — the widened-consumer, JavaScript-consumer, divergent-union and
changed-default cases.

**Consequences.** The harness also uses the baseline to verify each fixture's
premise — that both branches type-check alone. A fixture where one branch is
simply broken is rejected rather than counted as a win.

---

## ADR-0010 — Four-way reference classification

**Decision.** Classify each reference as `resolved`, `external`, `local`, or
`unresolved`. `resolutionRate` counts only `resolved / (resolved + unresolved)`.

**Supersedes** the original two-way `resolved` / `unresolved` split.

**Why.** The two-way count conflated "declared in `lib.es5.d.ts`" with "could
not resolve". On a real repository this reported **70%** resolution and
triggered an "analysis incomplete" warning on a perfectly healthy codebase:
`array.push(x)` resolves fine, its declaration simply lives somewhere no branch
can change. Measured on Hairline's own source: 2,518 external and 602 local
references were being counted as failures alongside 164 genuine ones.

The honesty machinery only works if its signals mean something. A warning that
fires on every healthy repository is a warning nobody reads.

**Consequences.** `Coverage` gained two fields, which is a JSON schema
addition. `local` covers declarations Hairline does not model — destructuring
patterns, catch parameters — which cannot participate in cross-branch
interactions anyway.
