# Progress

State of the project, for picking up cold. Reconstruct from `git log`,
`npm test`, `npm run evaluate`, and `docs/decisions.md` if this drifts.

---

## Current phase

**Phase 8 complete — real-world validation, and a second hardening pass.**
Phases 0–7 are done and verified; the MVP acceptance criteria are met. Phase 9
(integration surfaces: GitHub Action, PR annotations) has not been started,
deliberately — those are product surfaces, not the engine.

The second pass came from probing the change model for things it could not
see, and from running the engine against real repository history. Both found
real defects; see "What the second pass found".

## Verification status

```
npm run typecheck    clean  (strict, exactOptionalPropertyTypes,
                             noUncheckedIndexedAccess, erasableSyntaxOnly)
npm test             178 passing, 0 failing
npm run evaluate     precision 100%  recall 100%  TP 13 / FP 0 / TN 10 / FN 0
                     0 unmet expectations, 0 fixture premise failures
npm run build        clean
npm audit            0 vulnerabilities, 1 runtime dependency
npm run validate     0 findings over 6 real zod merge pairs
```

Test suites:

| Suite | Covers |
|---|---|
| `tests/unit/index-typescript.test.ts` | symbol, contract, reference and literal extraction |
| `tests/unit/changes.test.ts` | the change model — including that reformatting yields **no** change |
| `tests/unit/robustness.test.ts` | parse failures, path safety, limits, identity round-trips, honest incompleteness |
| `tests/unit/program-host.test.ts` | dependency resolution, `@types` discovery, disk-read confinement, revision isolation |
| `tests/integration/corpus.test.ts` | all 23 fixtures: premises, detection, finding shape, baseline agreement, determinism |
| `tests/unit/output-safety.test.ts` | repository content cannot forge terminal output |
| `tests/unit/budget.test.ts` | the extraction budget degrades honestly and invents nothing |
| `tests/integration/cli.test.ts` | argument parsing, exit codes, JSON schema, `explain`, HEAD/working-tree untouched |
| `tests/integration/git-layer.test.ts` | symlinks, size caps, binary content, partial clones, merge-tree, shell-safety |

## What exists

- Git layer reading revisions from the object database; `merge-tree` trial
  merges with no working-tree contact.
- TypeScript adapter: virtual `ts.Program` per revision, two-pass extraction of
  symbols, contracts, references, imports, export surfaces and literal
  observations, scoped to the affected subgraph and bounded by a time budget.
- Semantic graph, per-branch change model with typed `ContractDelta`s, rename
  detection.
- Seven analyzers, pair pruning, deduplication, confidence as a named rule.
- Human and JSON reporters; `analyze`, `explain` and `analyzers` commands with
  documented exit codes.
- 23-fixture corpus built as real git repositories, plus an evaluation harness
  that measures against `tsc` on the merged tree and verifies each fixture's
  premises — and a second harness that runs over real merge history.

## What the second pass found

Probing the change model for blind spots turned up four breaking changes it
could not see **at all** — each silent, each genuinely breaking:

| Gap | Now |
|---|---|
| `public` → `private` | `member-visibility-changed`, high confidence |
| member gains `readonly` | `member-readonly-changed` |
| instance member → `static` | `member-static-changed`, high confidence |
| barrel stops re-exporting | `export-surface` analyzer |

Fixing the third exposed a deeper bug: `objectShape` returned `undefined` for a
type with no members, so the differ skipped the comparison and *any* type
losing its last member was invisible. Class static sides were not modelled at
all.

Running against real history found two more:

- **Partial clones failed outright** (`ls-tree -l` needs blobs that are not
  there). CI uses them routinely. Fixed with a size-free fallback.
- **Contract extraction was 7.6 s of 8 s** on a 522-file repository. Real merge
  pairs touch a mean of **1.0%** of files, so extraction is now scoped to the
  affected subgraph — measured ~3× faster end to end.

And the budget test written for the last of those found a **correctness bug**:
a budget-degraded index manufactured `literal-removed` deltas, because a
missing literal set was read as "admits nothing" rather than "unknown". That is
the exact invariant the design rests on, violated in the differ. Fixed by
refusing to compare facets when either side's contract is not resolved.

## Current blockers

None.

## Known gaps

Ordered by how much they would change a reader's trust in the numbers.

1. **Precision outside the corpus is unmeasured.** 100% on 23 fixtures written
   alongside the analyzers is a statement about the fixtures. The next real
   measurement is a false-positive run over many pairs of real, unrelated,
   successfully-merged branches — every finding there is a false positive by
   construction. See `docs/evaluation.md`.
2. **Recall against real semantic conflicts is unknown.** Needs historical
   mining: merged PR pairs where the merge built cleanly but a later commit
   fixed an integration bug, labelled from the fixing commit.
3. **Overload sets are not matched across revisions.** Only the count delta is
   recorded; the first signature is compared in detail.
4. **Dependency types come from the working tree, not the revision.** A
   diagnostic fires when a branch changes `package.json`.
5. **Destructuring patterns and catch parameters get no identity.** Counted as
   `local`, so they cannot participate in interactions.
6. **7–18 s per pair on a 477-file repository**, for three revisions. Branches
   are indexed sequentially and nothing is cached between runs. Acceptable for
   a PR-open gate, not yet good.
7. **Two zod merge pairs took ~15 minutes each** in one measurement run and
   ~10–18 s when re-measured in isolation. The slow readings coincided with
   other heavy jobs on the machine, and the cause was never isolated. The
   extraction budget bounds the damage either way, but this is unexplained
   rather than fixed — worth reproducing on a quiet machine before trusting
   the fast numbers.

## Next concrete actions

In the order that would most increase confidence in the tool:

1. **Extend the real-world sample.** `npm run validate` works and the
   construction is sound; six pairs from one repository is not enough to claim
   a false-positive rate. Run it across several repositories *with dependencies
   installed*, so resolution is not capped at 70% by uninstalled packages.
2. **Historical validation for recall** — mine merges that built cleanly but
   were followed by a fix commit, and label from the fix rather than from
   Hairline. This is the number the corpus cannot produce.
3. **Index branches concurrently.** Three revisions are indexed sequentially
   today and they are independent. Roughly a 3× wall-clock win, unmeasured.
4. **Reproduce or dismiss the slow-pair anomaly** (gap 7) on a quiet machine.
5. Only then: Phase 9 integration surfaces.

## Note for whoever picks this up

A PostHog setup skill ran in this repository during development and
instrumented `src/git/repository.ts` and `src/git/snapshot.ts` with telemetry
that fired on every repository open and merge evaluation, and added
`posthog-node` to `dependencies`. That instrumentation was removed — it
contradicts the local-first requirement, put a blocking network call on the hot
path, and roughly doubled analysis time.

Left in place, untouched, because they are not mine to delete:
`src/analytics/posthog.ts`, `.posthog-events.json`,
`posthog-self-driving-report.md`, and `.claude/skills/integration-javascript_node/`.
`src/analytics/` is excluded from `tsconfig.json`. Decide what to do with
them; if telemetry is wanted, it needs to be opt-in and off the hot path.
