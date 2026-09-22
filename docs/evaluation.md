# Evaluation

How Hairline is measured, what the numbers currently are, and — importantly —
what they do not say.

```bash
npm run evaluate                    # human-readable
npm run evaluate -- --json out.json # machine-readable
npm test                            # per-fixture assertions
```

---

## What is measured

Three things, in descending order of how much they matter:

1. **Restraint.** Does Hairline stay silent when two branches touch related
   code and are actually fine?
2. **Detection.** Does it report the interaction when there is one?
3. **Value over the incumbent.** Which findings would a merge queue running
   `tsc --noEmit` already have caught?

The third exists because the research pass identified that baseline as the real
competitor, not a strawman: a repository with a merge queue and a type check as
a required check catches type-visible cross-branch breakage for free. An
evaluation that ignored it would be measuring against nothing.

---

## The corpus

`tests/fixtures/corpus.ts` — 23 fixtures, **13 positive / 10 negative**.

The balance is deliberate. The published static semantic-conflict detectors sit
around 0.43 precision — 26 false positives for 20 true positives — and the
failure mode that kills a pre-merge gate is noise, not misses. Half the corpus
exists to try to make Hairline fire when it should not.

Each fixture is materialised as a **real git repository** with a base commit
and two branch commits (`tests/fixtures/build.ts`), with fixed author and
commit timestamps so the same checkout produces the same object ids. Fixtures
are exercised through actual git history rather than in-memory snapshots
because a large share of what can go wrong lives in the git layer.

### Premises are verified, not asserted

A fixture only demonstrates something if its premises hold. Before scoring
anything, the harness checks:

- **Each branch type-checks on its own.** A fixture where one branch is simply
  broken is not a cross-branch interaction, and detecting it would be scoring
  against an empty net.
- **Git behaves as the fixture declares.** Almost all declare a clean merge;
  one declares a textual conflict. A mismatch fails the fixture.

Both are checked with real tooling (`src/evaluation/baseline.ts`), not with a
label. `premiseFailures` is reported separately from detection results, and
`npm test` fails on any.

### What the fixtures cover

**Positive — the contract moved under a consumer the other branch added:**

| Fixture | Baseline |
|---|---|
| `union-member-removed--typed-consumer` | catches |
| `union-member-removed--widened-consumer` | **misses** |
| `union-member-removed--javascript-consumer` | **misses** |
| `union-member-removed--lookup-table` | catches |
| `property-renamed-under-new-reader` | catches |
| `required-parameter-added-under-new-caller` | catches |
| `export-removed-under-new-importer` | catches |
| `return-became-nullable-under-new-caller` | catches |
| `same-symbol-divergent-union` | **misses** (git conflicts) |
| `default-argument-changed-under-new-caller` | **misses** |
| `barrel-stops-reexporting-under-new-importer` | catches |
| `sync-became-async-under-new-caller` | catches |
| `member-visibility-narrowed-under-new-reader` | catches |

**Negative — related edits that are genuinely fine:**

`negative--signature-changed-and-caller-updated` ·
`negative--union-member-added` · `negative--adjacent-edits-same-file` ·
`negative--optional-member-added` · `negative--unrelated-modules` ·
`negative--reformat-versus-real-change` ·
`negative--renamed-with-all-consumers-updated` ·
`negative--implementation-changed-no-new-consumer` ·
`negative--barrel-export-added` ·
`negative--sync-became-async-and-new-caller-awaits`

Several are paired with a positive that differs in exactly one respect —
`negative--signature-changed-and-caller-updated` against
`required-parameter-added-under-new-caller` is the same signature change, with
the new call site compatible rather than not. That pair is the direct test of
[ADR-0007](./decisions.md).

`negative--sync-became-async-and-new-caller-awaits` is the same idea applied to
[ADR-0013](./decisions.md): the *identical* sync-to-async change as its
positive counterpart, differing only in whether the new call site awaits. It is
worth noting that when this fixture was first written it produced a **false
positive** — the analyzer fell through to a generic "signature changed under a
new call site" rule. The suppression rule that fixed it exists because the
discriminating negative was written.

---

## Current results

Reproduce with `npm run evaluate`. Measured on Node 24.13.0, TypeScript 5.9.3,
git 2.50.1, macOS arm64.

```
Detection
  precision 100.0%   recall 100.0%   F1 100.0%
  TP 13  FP 0  TN 10  FN 0
  unmet expectations 0  ok
  fixture premise failures 0  ok

Against the incumbent baseline
  caught by both              9
  caught only by Hairline     4
    + union-member-removed--widened-consumer
    + union-member-removed--javascript-consumer
    + same-symbol-divergent-union
    + default-argument-changed-under-new-caller
```

`unmet expectations` is a stricter check than detection: several fixtures
declare the expected *category, severity, confidence and symbols*, so a finding
that is right by accident still fails.

### Real-world run: Hairline on itself

Hairline analysed its own source tree (8,607 LOC, 53 files) across two
synthetic agent branches — one narrowing the `ConfidenceLevel` union, the other
adding a reporter that handles the removed value:

```
indexed 142 file(s) across 3 revision(s) in 1680ms; analysis 34ms
1 finding — literal-set-conflict, medium confidence
reference resolution 97.9%
```

One finding from 9 + 9 contract changes, with the derived symbols correctly
grouped into a single report.

### Real-world run: history that actually happened

```bash
npm run validate -- --repo <path> --limit 25
```

`src/evaluation/real-world.ts` takes every **two-parent merge commit** in a
repository. Its parents and their merge base are exactly the three revisions
Hairline needs, and they are a branch pair that really diverged and really
merged. Nothing is reconstructed or synthesised.

Measured against [zod](https://github.com/colinhacks/zod) (3,232 commits, 477
TypeScript files):

| | |
|---|---|
| Merge pairs analysed | 6 |
| **Pairs with any finding** | **0** |
| Time per pair | 7–18 s (three revisions indexed each) |
| Mean reference resolution | 70% |

Zero findings across six real merges is the restraint result this is meant to
probe, and it is encouraging — but six pairs is a small sample, and the honest
caveats are as important as the number:

- **A finding here would be a *candidate* false positive, not a confirmed
  one.** These merges shipped, but shipping is not proof of correctness:
  [Brun et al. (TSE 2013)](https://homes.cs.washington.edu/~mernst/pubs/vc-conflicts-tse2013.pdf) found over 9% of textually clean merges fail
  to build or pass tests. The rate this measures is an upper bound.
- **70% resolution is low**, and the cause is visible: zod is a monorepo whose
  dependencies were not installed in the clone, so 2,262 type errors leave
  large parts of the program typed `any`. Hairline reports this (the coverage
  warning fires), but a run against a properly installed checkout would see
  considerably more.
- **Most merge commits are skipped**, being fast-forwards or touching no
  TypeScript. Getting a large sample needs many more repositories.

This harness exists so the next person can extend the sample rather than
re-derive the construction.

---

## What these numbers do not say

**100% precision on 23 fixtures is a statement about the fixtures.** They were
written alongside the analyzers, by the same author, in the same sitting. That
is unavoidable for a first corpus and it is not evidence of real-world
precision. The published detectors that *were* measured on independent data
sit at 0.43–0.85; IntelliMerge self-reported 88% precision and an independent
replication found 50% incorrect merges. Hairline should be assumed closer to
that world until measured on data it did not author.

**The corpus is small and synthetic.** 23 fixtures of a few files each. Barrel
files are now represented, but generics, decorators, dependency injection,
declaration merging and monorepo boundaries are not. The indexer handles those
shapes — verified separately on real repositories — but no *fixture* exercises
a conflict through one.

**Recall is unmeasurable from this corpus.** It can only say Hairline finds the
conflicts that were written for it. The genuinely interesting number — what
fraction of *real* semantic conflicts it catches — needs historical data. The
finding that over 9% of textually clean merges fail to build or pass tests
([Brun et al., TSE 2013](https://homes.cs.washington.edu/~mernst/pubs/vc-conflicts-tse2013.pdf), quoted by the
[ASE 2024 merge-tool evaluation](https://arxiv.org/abs/2410.09934)) is the
target to measure against, and has not been.

**The timing comparison is not a fair fight, in both directions.** Hairline and
the baseline run on the same tiny fixtures, where process startup dominates.
Hairline's real advantage is not milliseconds — it is that it runs at PR-open
time against two branches, needs no build, no installed toolchain and no
network, and attributes the problem to specific branches and symbols. The
baseline's real advantage is that it is *already configured* in many
repositories and requires no new tool.

**Four fixtures "caught only by Hairline" is four fixtures.** It demonstrates
the class exists and that Hairline can see it. It does not establish how often
that class occurs in practice.

**The capabilities added in the second pass mostly land in the baseline's
half.** Barrel narrowing, `public` → `private` and sync → async are all things
a merged-tree type check also catches. They were added because the change model
was *silently blind* to them — a gap worth closing on its own terms — but they
widen coverage rather than widen the differentiator.

---

## Honest accounting of where value comes from

Of the 13 positive fixtures:

- **9** are also caught by type-checking the merged tree. On these Hairline
  adds *attribution* ("branch A removed it, branch B added the consumer")
  and *timing* (PR-open rather than queue-head), not detection. A repository
  with a merge queue already has the detection.
- **4** are invisible to the baseline:
  - a consumer whose type has been widened to `string`
  - a JavaScript consumer with no types at all
  - two branches leaving the same contract in different states
  - a changed default argument with a byte-identical signature

The second group is the differentiator. It is also the group with the weaker
confidence levels, which is the honest position: these are the cases nothing
else can see, *and* the cases Hairline cannot decide.

---

## Per-rule accountability

Every finding carries a `confidenceBasis` — a stable rule id. The JSON report
includes it per finding, so precision can be attributed to individual rules
rather than to the tool as a whole. This matters because the rules are not
equally trustworthy: `removed-symbol-still-referenced` is decidable from the
index, while `removed-literal-value-matches-elsewhere` is a text match and is
below the default reporting threshold for that reason.

`--min-confidence low` computes and reports everything, including rules that
are off by default. Low-confidence rules exist so they can be *measured*; a
rule that only ever produces false positives should be visible in the numbers
and then deleted.

---

## Reproducibility

Fixtures are generated from source in this repository with fixed git
timestamps, so a given checkout produces identical object ids and identical
finding ids. Finding ids are content-derived — analyzer, category, branches,
symbols and evidence — and deliberately exclude positions, so the same analysis
over the same commits always yields the same ids. `tests/integration/corpus.test.ts`
asserts this directly.

No benchmark expectation is hard-coded to a produced value. Fixture
expectations state category, severity, confidence and symbols, and were written
from the intended semantics rather than from observed output.

---

## What should be measured next

1. **Historical validation.** Mine real repositories for pairs of merged PRs
   with a common ancestor where the merge built cleanly but a subsequent commit
   fixed an integration bug. Label from the fixing commit, not from Hairline.
2. **False-positive rate on ordinary concurrent work.** Run over many pairs of
   real, unrelated, successfully-merged branches. Every finding is a false
   positive by construction. This is the number that decides whether the tool
   is usable as a gate, and it is currently unknown.
3. **Scale.** Largest repository tested is 8,607 LOC. Indexing is linear in
   source size and memory-bound; the crossover where caching becomes necessary
   has not been found.
4. **Per-rule precision on independent data**, so individual rules can be
   promoted, demoted or removed on evidence.
