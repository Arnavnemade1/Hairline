# Progress

State of the project, for picking up cold. Reconstruct from `git log`,
`npm test`, `npm run evaluate`, and `docs/decisions.md` if this drifts.

---

## Current phase

**Phase 8 complete — real-world validation.** Phases 0–7 of the plan are done
and verified. The MVP acceptance criteria are met. Phase 9 (integration
surfaces: GitHub Action, PR annotations) has not been started, deliberately —
those are product surfaces, not the engine.

## Verification status

```
npm run typecheck    clean  (strict, exactOptionalPropertyTypes,
                             noUncheckedIndexedAccess, erasableSyntaxOnly)
npm test             all passing — unit + integration
npm run evaluate     precision 100%  recall 100%  TP 10 / FP 0 / TN 8 / FN 0
                     0 unmet expectations, 0 fixture premise failures
npm run build        clean
npm audit            0 vulnerabilities, 1 runtime dependency
```

Test suites:

| Suite | Covers |
|---|---|
| `tests/unit/index-typescript.test.ts` | symbol, contract, reference and literal extraction |
| `tests/unit/changes.test.ts` | the change model — including that reformatting yields **no** change |
| `tests/unit/robustness.test.ts` | parse failures, path safety, limits, identity round-trips, honest incompleteness |
| `tests/unit/program-host.test.ts` | dependency resolution, `@types` discovery, disk-read confinement, revision isolation |
| `tests/integration/corpus.test.ts` | all 18 fixtures: premises, detection, finding shape, baseline agreement, determinism |
| `tests/integration/cli.test.ts` | argument parsing, exit codes, JSON schema, HEAD/working-tree untouched |

## What exists

- Git layer reading revisions from the object database; `merge-tree` trial
  merges with no working-tree contact.
- TypeScript adapter: virtual `ts.Program` per revision, two-pass extraction of
  symbols, contracts, references, imports, and literal observations.
- Semantic graph, per-branch change model with typed `ContractDelta`s, rename
  detection.
- Six analyzers, pair pruning, deduplication, confidence as a named rule.
- Human and JSON reporters; CLI with documented exit codes.
- 18-fixture corpus built as real git repositories, plus an evaluation harness
  that measures against `tsc` on the merged tree and verifies each fixture's
  premises.

## Current blockers

None.

## Known gaps

Ordered by how much they would change a reader's trust in the numbers.

1. **Precision outside the corpus is unmeasured.** 100% on 18 fixtures written
   alongside the analyzers is a statement about the fixtures. The next real
   measurement is a false-positive run over many pairs of real, unrelated,
   successfully-merged branches — every finding there is a false positive by
   construction. See `docs/evaluation.md`.
2. **Recall against real semantic conflicts is unknown.** Needs historical
   mining: merged PR pairs where the merge built cleanly but a later commit
   fixed an integration bug, labelled from the fixing commit.
3. **Overload sets are not matched across revisions.** Only the count delta is
   recorded; the first signature is compared in detail.
4. **Terminal output is not sanitised** for control characters originating in
   repository string literals (`docs/threat-model.md`). The JSON reporter is
   unaffected. Small, unfixed.
5. **Dependency types come from the working tree, not the revision.** A
   diagnostic fires when a branch changes `package.json`.
6. **Destructuring patterns and catch parameters get no identity.** Counted as
   `local`, so they cannot participate in interactions.
7. **Largest repository tested is 8,607 LOC.** No caching, no incremental
   indexing, no parallelism — correctness first, and analysis is 34 ms against
   1.7 s of indexing, so the pressure is entirely on indexing.

## Next concrete actions

In the order that would most increase confidence in the tool:

1. **Measure the false-positive rate on real merged branch pairs.** Clone a
   few active TypeScript repositories, find pairs of PRs with a common
   ancestor that merged successfully, run Hairline over each pair, and count
   findings. This is the number that decides whether Hairline is usable as a
   gate.
2. **Sanitise control characters in `src/reporters/human.ts`.** Small and
   known.
3. **Cache parsed `SourceFile`s by blob oid across revisions.** Most files are
   identical between two commits; this is the obvious indexing win. Benchmark
   before and after. Module resolution caches must **not** be shared across
   revisions.
4. **Historical validation** (gap 2), which is the recall story.
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
