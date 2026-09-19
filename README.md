# Hairline

**A semantic integration engine: it finds conflicts between concurrent branches
that Git merges cleanly.**

Git reasons about lines. When two agents work on the same repository at the
same time, the interesting failures are not textual:

```
Agent A                          Agent B
   │                                │
   ├── changes a shared contract    ├── changes a consumer of it
   │                                │
   ├── its own tests pass  ✓        ├── its own tests pass  ✓
   │                                │
   └────────────────┬───────────────┘
                    │
              git merge — clean  ✓
                    │
              the system is broken
```

Hairline indexes each revision into a semantic graph — symbols, references,
imports, types, signatures, and the concrete values a type admits — diffs each
branch against the merge base, and reports where one branch's contract change
meets another branch's new code.

It never merges, never rewrites, never executes repository code, and never
talks to the network.

---

## The demonstration

```bash
npm run demo
```

Every line of this is produced by actually doing the thing — git really merges
the branches, `tsc` really runs on each branch and on the merged tree:

```
1. Does Git merge these branches?
  $ git merge-tree --write-tree agent-a agent-b
  1d860353c4bfd39783d17e090d409f7ba0c38109
  exit 0 — merges cleanly, no textual conflict

2. Does each branch pass a type check on its own?
  agent-a    PASS
  agent-b    PASS

3. Does a type check of the merged tree catch it?
  PASS — tsc reports no errors on the merged tree.
  This is what a merge queue with a `tsc --noEmit` required check would see.

4. What does Hairline say?
```

```
  1 likely semantic integration conflict (1 high severity)

[1/1] HIGH   agent-a removes "disabled" from `Status (src/user.ts)`;
             agent-b adds code handling it
        literal-set-conflict  confidence: medium  id 8a47418b3ed1

        agent-a narrows `Status (src/user.ts)` so that "disabled" is no longer
        one of its values. agent-b adds 1 site that still names "disabled".
        That site is typed loosely enough that type-checking the merged tree
        would not report this — the code would simply become unreachable at
        runtime.

        Evidence
          agent-a  `Status`: literal "disabled" removed from the admissible set
                   src/user.ts:1:1
            - "active" | "disabled" | "suspended"
            + "active" | "suspended"
          agent-a  Also narrows 1 symbol(s) typed by it: User.status
          agent-b  New equality on "disabled" against `status` — type at the
                   site is `string`, so a type check cannot see this
                   src/render.ts:5:18

        Why this confidence
          The value is named in a module that imports the changed one, but the
          type at that site has been widened to a primitive. A type check of
          the merged tree would not flag it; whether the value still reaches
          this code is not decided here.

        Suggested check
          Check whether the branch handling "disabled" on agent-b can still be
          reached, and whether removing the value was intended.
```

The consumer takes a `string`, not a `Status`. By the time the value arrives,
the type system has widened it away — so type-checking the merged tree is
clean, and the branch just becomes dead code. That is the class of problem
Hairline exists for.

---

## Install and use

Requires **Node ≥ 22.6** and **git ≥ 2.38** (for `merge-tree --write-tree`).

```bash
git clone <repo> && cd hairline
npm install        # one runtime dependency: typescript
npm test
npm run build      # produces dist/, which bin/hairline.js runs
```

Then either run the built binary directly, or `npm link` it onto your PATH:

```bash
node bin/hairline.js analyze --base main --branches agent-a agent-b
node bin/hairline.js analyze --base main --branch agent-a --branch agent-b --json
node bin/hairline.js analyzers        # what each analyzer looks for
```

To run from source without building — which is what the test suite does —
use `npm run hairline --`:

```bash
npm run hairline -- analyze --base main --branches agent-a agent-b
```

| Flag | Meaning |
|---|---|
| `--base <ref>` | revision the branches diverged from (default `main`) |
| `--branch <ref>` | a branch to analyse; repeat for each |
| `--branches <ref>...` | several branches positionally |
| `--repo <path>` | repository to analyse (default: cwd) |
| `--min-confidence` | `high` \| `medium` \| `low` (default `medium`) |
| `--json` | machine-readable report |
| `--no-installed-deps` | do not read `node_modules` for dependency types |

**Exit codes** — the primary consumer is a CI step deciding whether to stop:

| Code | Meaning |
|---|---|
| `0` | analysis ran, nothing found at or above the threshold |
| `1` | findings reported |
| `2` | invalid usage |
| `3` | **analysis could not complete** |

`3` is distinct from `0` on purpose. A failure must never read as "nothing
found".

---

## What it detects

| Analyzer | Looks for |
|---|---|
| `removed-definition` | a symbol one branch deleted or un-exported, used by code the other added |
| `literal-set-change` | a value removed from a type's admissible set, still named by new code |
| `signature-change` | a call signature changed under a call site the other branch added |
| `member-change` | a type member changed under a new read or write |
| `same-symbol` | both branches left the same contract in different states |
| `behavioral-risk` | a changed default or constant under new consumers — a prompt, not a verdict |

Every finding carries its **evidence** (concrete facts with file positions on a
named branch), a **confidence level** set by a named rule, the **rationale**
for that level, and **what to check**.

---

## Honest positioning

**Already solved, and conceded.** A GitHub merge queue running `tsc --noEmit`
as a required check catches type-visible cross-branch breakage for free. On 6
of the 10 positive fixtures, Hairline adds *attribution* ("branch A removed it,
branch B added the consumer") and *timing* (PR-open rather than queue-head),
not detection. Textual conflict resolution belongs to
[Mergiraf](https://mergiraf.org/) and Hairline does not compete with it.

**Where it adds detection.** 4 of 10 are invisible to that baseline: a consumer
whose type has been widened to `string`; a JavaScript consumer with no types;
two branches leaving the same contract in different states; a changed default
argument with a byte-identical signature. This is measured, not asserted —
`src/evaluation/baseline.ts` runs the incumbent over the same fixtures on every
evaluation.

**What it cannot do.** It cannot decide whether a body change altered
behaviour. No static analysis here establishes that, and the one analyzer that
touches the question refuses to fire without a value-level signal and caps
itself at low confidence. Hairline says *"likely"* and *"evidence that these
changes interact"*, never *"proved incompatible"*.

Current numbers, caveats, and what is still unmeasured:
[docs/evaluation.md](./docs/evaluation.md).

---

## Results

```
Detection
  precision 100.0%   recall 100.0%   F1 100.0%
  TP 10  FP 0  TN 8  FN 0

Against the incumbent baseline
  caught by both              6
  caught only by Hairline     4
```

**18 fixtures, 10 positive and 8 negative.** The balance is deliberate: the
published static semantic-conflict detectors sit around 0.43 precision, and the
failure mode that kills a pre-merge gate is noise, not misses.

**100% on 18 hand-built fixtures is a statement about the fixtures**, which
were written alongside the analyzers by the same author. Precision on data
Hairline did not author is unmeasured. See
[what these numbers do not say](./docs/evaluation.md#what-these-numbers-do-not-say).

On a real codebase — Hairline's own 8,607-LOC source across two synthetic agent
branches — it reported **one** finding from 9 + 9 contract changes, indexing
three revisions in 1.7 s with 34 ms of analysis.

---

## How it works

```
Repository → snapshot per revision (git objects; the working tree is never touched)
           → LanguageAdapter.index()  — virtual ts.Program, two-pass walk
           → SemanticIndex            — symbols · references · imports · literals
           → diffIndexes()            — typed ContractDeltas per branch
           → analyzers                — one ordered pair at a time
           → Finding[]                — evidence · severity · confidence
```

Two properties do most of the work:

**Symbol identity never uses line numbers.** `ts:src/user.ts#User.status@property`
survives reformatting and unrelated edits. Positions travel separately, as
evidence.

**Only *fresh* use sites count.** An interaction is reported only when the
consuming branch introduced or edited the use site. If a use site already
existed at the base and one branch broke it, that branch is broken on its own
and its own CI will catch it — it is not a cross-branch problem. This is the
main reason the negative fixtures stay silent.

Full design: [docs/architecture.md](./docs/architecture.md).

---

## Adding a language

Implement `LanguageAdapter`, declare honest `AdapterCapabilities`, add
fixtures. Nothing else changes: the graph, change model, analyzers and
reporters are written against `SemanticIndex` and never against TypeScript.

Capabilities are declared rather than inferred, so an adapter without a type
checker still produces useful `literalSets` and `references` findings at
correspondingly lower confidence — instead of a silent absence that reads as
"no conflicts here".

---

## Safety

Repository content is treated as untrusted input. Hairline never executes it,
never writes to the repository (HEAD and the working tree are asserted
unchanged by test), and never uses a network. Git is invoked with explicit
argument vectors and no shell. Disk reads are confined to TypeScript's `lib/`
and, opt-in, one `node_modules`.

[docs/threat-model.md](./docs/threat-model.md), including known gaps.

---

## Documentation

| | |
|---|---|
| [research.md](./docs/research.md) | prior art, what it solves, what it does not, and what changed the design |
| [architecture.md](./docs/architecture.md) | the model, the pipeline, and why findings are precise |
| [decisions.md](./docs/decisions.md) | ADRs with the evidence behind them |
| [evaluation.md](./docs/evaluation.md) | how it is measured, and what the numbers do not say |
| [threat-model.md](./docs/threat-model.md) | trust boundaries, mitigations, known gaps |
| [progress.md](./progress.md) | current state and next concrete steps |

---

## Licence

Apache-2.0.
