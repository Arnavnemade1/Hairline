import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS } from '../fixtures/corpus.ts';
import { evaluateFixture, type FixtureOutcome } from '../evaluation/harness.ts';

/**
 * The corpus, asserted one fixture at a time.
 *
 * Deliberately separate from `scripts/evaluate.ts`, which reports aggregate
 * precision and recall. Aggregates tell you the tool is healthy; these tests
 * tell you *which* case regressed, which is what a failing CI run needs to say.
 *
 * Each fixture is evaluated once and its outcome shared across the assertions
 * about it — building three git repositories and four TypeScript programs per
 * fixture is the dominant cost, and doing it per assertion would make the
 * suite too slow to run on every change.
 */

const outcomes = new Map<string, FixtureOutcome>();

before(async () => {
  for (const fixture of CORPUS) {
    outcomes.set(fixture.name, await evaluateFixture(fixture));
  }
});

function outcomeFor(name: string): FixtureOutcome {
  const outcome = outcomes.get(name);
  assert.ok(outcome, `no outcome recorded for ${name}`);
  return outcome;
}

describe('fixture premises', () => {
  for (const fixture of CORPUS) {
    test(`${fixture.name}: both branches stand on their own and git behaves as declared`, () => {
      const outcome = outcomeFor(fixture.name);
      assert.deepEqual(
        outcome.premiseFailures,
        [],
        `the fixture itself is broken: ${outcome.premiseFailures.join('; ')}`,
      );
    });
  }
});

describe('detection', () => {
  for (const fixture of CORPUS) {
    const expectation = fixture.conflict ? 'reports an interaction' : 'stays silent';
    test(`${fixture.name}: ${expectation}`, () => {
      const outcome = outcomeFor(fixture.name);
      assert.equal(
        outcome.detected,
        fixture.conflict,
        fixture.conflict
          ? 'expected at least one finding, got none'
          : `expected no findings, got: ${outcome.findings.map((f) => `[${f.analyzer}] ${f.title}`).join(' | ')}`,
      );
    });
  }
});

describe('finding shape', () => {
  for (const fixture of CORPUS.filter((f) => f.expect && f.expect.length > 0)) {
    test(`${fixture.name}: produces the expected category, severity and symbols`, () => {
      const outcome = outcomeFor(fixture.name);
      assert.deepEqual(
        outcome.unmet,
        [],
        `unmet expectations; actual findings were: ${outcome.findings
          .map((f) => `${f.category}/${f.severity}/${f.confidence.level} ${f.symbols.join(',')}`)
          .join(' | ')}`,
      );
    });
  }
});

describe('every finding carries its evidence', () => {
  test('no finding is asserted without checkable facts behind it', () => {
    for (const outcome of outcomes.values()) {
      for (const finding of outcome.findings) {
        assert.ok(
          finding.evidence.length > 0,
          `${outcome.fixture}: ${finding.analyzer} produced a finding with no evidence`,
        );
        assert.ok(
          finding.evidence.some((e) => e.range !== undefined),
          `${outcome.fixture}: ${finding.analyzer} produced no evidence pointing at real code`,
        );
        assert.ok(
          finding.branches.length >= 2,
          `${outcome.fixture}: a finding must involve at least two branches`,
        );
        assert.ok(
          finding.confidence.rationale.length > 20,
          `${outcome.fixture}: ${finding.confidence.basis} has no rationale`,
        );
        assert.ok(
          finding.verification.length > 0,
          `${outcome.fixture}: ${finding.analyzer} suggests nothing to check`,
        );
      }
    }
  });
});

describe('baseline comparison', () => {
  for (const fixture of CORPUS) {
    test(`${fixture.name}: the merged-tree type check behaves as documented (${fixture.baseline})`, () => {
      const outcome = outcomeFor(fixture.name);
      assert.equal(
        outcome.baselineAgreedWithExpectation,
        true,
        `fixture declares baseline '${fixture.baseline}' but tsc on the merged tree ` +
          `${outcome.baselineDetected ? 'reported errors' : 'was clean'}`,
      );
    });
  }

  test('at least one conflict is found that the merged-tree type check misses', () => {
    const beyond = [...outcomes.values()].filter(
      (o) => o.classification === 'TP' && !o.baselineDetected,
    );
    assert.ok(
      beyond.length > 0,
      'if every finding is also a type error, Hairline adds attribution but no detection',
    );
  });
});

describe('determinism', () => {
  test('finding ids are stable across runs of the same fixture', async () => {
    const fixture = CORPUS.find((f) => f.name === 'union-member-removed--widened-consumer')!;
    const first = await evaluateFixture(fixture);
    const second = await evaluateFixture(fixture);
    assert.deepEqual(
      first.findings.map((f) => f.id),
      second.findings.map((f) => f.id),
    );
    assert.ok(first.findings.length > 0);
  });
});
