# Architecture

How Hairline goes from a repository to a finding, and where the seams are.

---

## The pipeline

```
Repository (git object database — never the working tree)
    │
    ├── merge base of { base, branch₁ … branchₙ }
    │
    ▼
RepositorySnapshot  ×(n+1)            src/git/snapshot.ts
    files at one revision, read lazily, size- and shape-capped
    │
    ▼
LanguageAdapter.index()               src/languages/typescript/
    virtual ts.Program over the snapshot   → program.ts
    two-pass walk                          → extract.ts
    contract extraction from the checker   → contracts.ts
    │
    ▼
SemanticIndex  ×(n+1)                 src/core/model/snapshot.ts
    symbols · references · imports · exports · literal observations
    diagnostics · coverage
    │
    ├──────────────► SemanticGraph     src/core/graph/
    │                   adjacency: who references what, who imports what
    ▼
diffIndexes(base, branch)             src/core/changes/differ.ts
    │
    ▼
BranchChangeSet  ×n                   src/core/changes/model.ts
    symbol changes as typed ContractDeltas
    added/removed references, literals, imports
    rename candidates
    │
    ▼
BranchView  ×n                        src/core/analysis/context.ts
    contract changes · *fresh* use sites · *fresh* literal observations
    │
    ▼
pair pruning ──► analyzers            src/core/analysis/
    removed-definition · export-surface · literal-set-change
    signature-change · member-change · same-symbol · behavioral-risk
    │
    ▼
deduplicate → Finding[]               src/core/model/findings.ts
    evidence · severity · confidence(level, basis, rationale)
    │
    ├──► renderHuman                  src/reporters/human.ts
    └──► renderJson                   src/reporters/json.ts
```

Two rules keep the layers honest: nothing below `languages/` mentions
TypeScript, and nothing in `core/` knows about terminals, git, or GitHub.

---

## What is modelled

### Identity

A symbol id is `ts:<module>#<dotted.path>@<kind>[~<n>]`:

```
ts:src/user.ts#Status@type-alias
ts:src/user.ts#User.status@property
ts:src/api.ts#fetchUser@function
ts:src/api.ts#fetchUser.id@parameter
```

Never derived from line or byte offsets, so it survives reformatting, line
movement and unrelated edits. Positions travel separately as *evidence*, valid
only against the revision they came from. Kinds participate in identity because
a `type Foo` and a `function Foo` are different things. See
[ADR-0004](./decisions.md).

### Contracts

The central distinction is between what a symbol *promises* and how it is
*implemented*.

```ts
interface Contract {
  typeText?: string          // the checker's rendering; the primary key
  typeResolved: boolean      // false means UNKNOWN, never "absent"
  callable?: CallableShape[] // parameters, arity, return type — overloads
  object?: ObjectShape       // members, heritage, index signatures
  literals?: LiteralSet      // admissible literal values, and openness
  initializerText?: string
  bodyHash?: string          // normalised implementation fingerprint
  ambient?: boolean
}
```

Three things about this are load-bearing.

**`typeResolved` distinguishes unknown from absent.** A missing `literals` with
`typeResolved: false` means the checker could not tell us, not that the type
admits no literals. Collapsing those two is how a static analyser quietly
becomes untrustworthy.

**`typeText` is fully qualified** (`import("src/user").Status`) so that two
same-named types from different modules never compare equal. `displayTypeText`
strips the qualification for reports — the reader already has the file path.

**`LiteralSet.open`** records whether the type also admits non-literal values.
An open set can never be used to argue a particular value became impossible,
and every analyzer respects that.

### Export surfaces

What a module *declares* and what it *provides* come apart constantly:

```ts
// src/index.ts — declares nothing, exports everything
export { formatDate, formatNumber } from './format.ts';   // before
export { formatNumber } from './format.ts';               // after
```

`formatDate` is untouched, but it has left the package's entry point. No
symbol changed, so a symbol-level comparison sees nothing. `ExportedName`
records the surface separately — asked of the checker via
`getExportsOfModule`, so `export *` is expanded, re-export chains are followed
to the declaration, and renames are reported under the name importers must
use. See [ADR-0011](./decisions.md).

### Literal observations

Alongside references, the extractor records every place source code *names a
concrete value*:

```ts
interface LiteralObservation {
  value: string            // JSON-encoded: "disabled"
  context: 'equality' | 'switch-case' | 'object-key' | 'property-access'
         | 'array-membership' | 'assignment' | 'literal-type'
  against?: SymbolId       // the named type constraining this position
  viaSymbol?: SymbolId     // the value whose type that is
  siteTypeText?: string    // how the checker actually typed the position
  enclosing: SymbolId
  range: SourceRange
}
```

`siteTypeText` is the field that earns this whole mechanism. When it reads
`string` rather than `Status`, the type system has *already widened the value
away* — a type check of the merged tree cannot flag a mismatch at that site
even in principle. That is the class of problem nothing in the prior art
addresses, and recording the site's actual type is what lets a finding say so
instead of asserting it.

`object-key` observations are recorded only when the contextual type is a
*mapped* type (`Record<Status, string>`). Recording every object-literal key
would bury the signal in noise.

### Changes

`ContractDelta` is the vocabulary the engine reasons in — deliberately
fine-grained, because "the contract changed" cannot decide whether a given
consumer is affected but "the second parameter became required" can.

`deltaImpact(delta)` maps a delta to the *kinds of consumer it can reach*:
callers, readers, implementers, importers. A `parameter-removed` reaches call
sites but not type positions; a `member-removed` reaches readers but not
callers. This is the difference between "these two symbols are related" and
"this change reaches this use site".

Reference and literal diffing keys deliberately exclude positions: a call that
moved down twelve lines has not changed.

---

## Why findings are precise

### Only *fresh* use sites count

The single most important precision decision. An interaction is reported only
when the consuming branch **introduced or edited** the use site.

If a use site already existed at the merge base and branch A broke it, A is
broken *on its own* — A's own type check would catch it. The premise of the
product is that both branches are green in isolation, and that can only happen
when the contract change and the use site were invisible to each other. See
[ADR-0007](./decisions.md).

### Pair pruning

With N branches there are N(N−1) ordered pairs, most touching unrelated code.
`summarisePair` intersects changed symbols, changed modules, cross-branch
references and removed literal values first. Pairs with no overlap are recorded
as *not analysed, with the reason* rather than silently omitted — so the report
can say what it did not look at.

### Analyzers see one ordered pair

Each analyzer handles "producer changed a contract, consumer depends on it" and
never both directions at once. The engine runs both orderings; the one
symmetric analyzer (`same-symbol`) de-duplicates by acting on a single
ordering.

### Deduplication

Several analyzers legitimately see the same event. Findings are collapsed by
(branches, symbols, category), keeping the strongest; then a high-confidence
finding about a symbol suppresses weaker findings about the same symbol.

The literal-set analyzer additionally groups by *removed value* rather than by
symbol, because narrowing `Status` also narrows every property typed by it —
one edit, six delta records, one finding.

---

## Confidence

Three levels, each set by a **named rule** carried in the finding:

| Rule | Level | Decidable? |
|---|---|---|
| `removed-symbol-still-referenced` | high | yes — nothing to bind to |
| `removed-export-newly-imported` | high | yes — the name is gone from the surface |
| `removed-member-still-accessed` | high | yes |
| `member-hidden-under-new-external-access` | high | yes — no longer public |
| `member-moved-between-instance-and-static` | high | yes |
| `arity-mismatch-at-new-call-site` | high | yes — by counting |
| `result-became-a-promise-at-an-unawaited-call-site` | high | yes — the site does not await |
| `removed-literal-observed-against-changed-type` | high | yes |
| `divergent-changes-to-same-contract` | high | yes — outcomes differ |
| `symbol-deleted-and-modified` | high | yes |
| `removed-literal-observed-at-widened-site` | medium | **no — and a type check cannot see it either** |
| `removed-literal-observed-in-dependent-module` | medium | no |
| `removed-export-under-new-namespace-import` | medium | no — the member is not named |
| `signature-changed-under-new-call-site` | medium | no — would need to check the merged tree |
| `member-changed-under-new-access` | medium | no |
| `result-became-nullable-under-new-consumer` | medium | no |
| `value-change-under-new-consumer` | low | no — behaviour is not decided here |
| `removed-literal-value-matches-elsewhere` | low | no — text match only |

The level is not a probability ([ADR-0008](./decisions.md)). Naming the rule is
what makes per-rule precision measurable.

---

## Honest incompleteness

Every result carries `Coverage` and `AnalysisDiagnostic[]`, because a finding
count means little without them — *"0 findings, 4 of 500 files indexed"* is not
a clean bill of health.

Diagnostic codes: `parse-failed`, `type-unavailable`, `unresolved-import`,
`unresolved-reference`, `file-skipped`, `unsupported-construct`,
`limit-exceeded`, `snapshot-failed`.

References are classified four ways, and only the last is a gap:

| Class | Meaning |
|---|---|
| `resolved` | bound to a declaration in this repository |
| `external` | bound to `lib.d.ts` or `node_modules` — no branch can change it |
| `local` | bound to something in-repo that Hairline does not model (destructuring, catch params) |
| `unresolved` | bound to nothing |

Conflating `external` with `unresolved` reported 70% resolution on a healthy
repository and buried the 164 genuine failures among 2,518 harmless ones
([ADR-0010](./decisions.md)).

The CLI distinguishes the three outcomes by exit code: `0` nothing found, `1`
findings reported, `2` bad usage, `3` **analysis could not complete**. A
failure must never read as "nothing found".

---

## Body fingerprints

`bodyHash` is built from the AST token stream, not source text: comments,
whitespace and parenthesisation are excluded, while identifier and literal text
is included. Renaming a local is invisible; calling a different function is not.

**A differing hash proves the body changed. It proves nothing about whether the
behaviour changed.** No analyzer treats it as evidence of a conflict on its
own, and `behavioral-risk` refuses to fire without an accompanying value-level
signal such as a changed default argument. A rule that fired on every body
change would flag most of a normal day's work.

---

## Adding a language

Implement `LanguageAdapter` and declare honest `AdapterCapabilities`:

```ts
interface LanguageAdapter {
  id: LanguageId
  capabilities: AdapterCapabilities   // parse, symbols, references, types,
                                      // signatures, literalSets, modules
  index(snapshot, options): SemanticIndex
}
```

Nothing else changes. The graph, change model, analyzers and reporters are
written against `SemanticIndex` and never against TypeScript.

Capabilities are *declared* rather than inferred so analyzers can ask "do I
have type information here?" instead of guessing from absence — a language
whose adapter cannot resolve types is not the same as a language with no type
conflicts. An adapter reporting `types: false` still produces useful
`literalSets` and `references` findings, at correspondingly lower confidence.

---

## Performance

Profiled on a real repository (zod, 522 files, one revision):

| Stage | Time | Note |
|---|---|---|
| Snapshot from git objects | 55 ms | |
| `ts.createProgram` | 461 ms | `skipLibCheck: true` is a measured ~3× win |
| **Contract extraction** | **7,607 ms** | 23,972 declarations |
| Identifier resolution | 744 ms | 194,778 identifiers |
| Bare AST walk | 23 ms | 564,107 nodes |

Contract extraction dominates by an order of magnitude — asking the checker to
render types, list members and resolve signatures is simply expensive. An
earlier measurement on a 51-file project had suggested identifier resolution
was the concern; it did not generalise.

The fix is scope, not speed. Measured over real zod merge pairs, **a merge pair
touches a mean of 1.0% of files**. Full contracts are therefore computed only
for files that changed, plus their direct importers; everything else gets
identity, export status and a body fingerprint, which is all the differ needs
to see that nothing changed. This is sound rather than approximate: an
unchanged file's symbols are byte-identical on every side and compare equal
whatever detail is recorded. See [ADR-0014](./decisions.md).

Caching extraction per file by blob oid looks obvious and is **unsound**: a
file's contracts depend on the whole program, so `export function f(): User`
changes when `User` changes elsewhere even though `f`'s bytes did not.

Still unoptimised, deliberately: branches are indexed sequentially rather than
concurrently, and nothing is cached between runs. Module resolution caches
must **not** be shared across revisions, or one revision's resolutions leak
into another.

---

## Deliberate non-goals

Hairline does not merge, resolve, or rewrite code; does not execute repository
code; does not require a build, an installed toolchain, or a network; does not
depend on an LLM for correctness; and does not claim behavioural equivalence.

Dynamic validation — speculatively merging, running the combined test suite,
and explaining failures semantically — is a plausible later phase. The
architecture keeps it possible (`buildSnapshotFromTree` already indexes the
speculative merge result) without making it mandatory.
