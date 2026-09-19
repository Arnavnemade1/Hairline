import type { Fixture } from './types.ts';

/**
 * The adversarial corpus.
 *
 * Every fixture is a pair of branches that a Git merge accepts (except where
 * `gitConflict` says otherwise) and that each type-check on their own. The
 * harness asserts both of those premises mechanically rather than taking the
 * label's word for it, because a fixture where one branch is simply broken
 * would prove nothing about *interaction*.
 *
 * Roughly half the fixtures are negative controls. That balance is deliberate:
 * the published static semantic-conflict detectors report precision around
 * 43%, and the failure mode that kills a pre-merge tool is noise, not misses.
 */

// --------------------------------------------------------------------------
// Positive: contract changed on one branch, consumer added on the other.
// --------------------------------------------------------------------------

const unionMemberRemovedTyped: Fixture = {
  name: 'union-member-removed--typed-consumer',
  summary:
    'Agent A drops "disabled" from the Status union; Agent B adds a switch case handling "disabled".',
  conflict: true,
  baseline: 'catches',
  note: 'The canonical case. A type check of the merged tree also catches this one, because the consuming site is still precisely typed — Hairline adds attribution and pre-merge timing rather than new detection.',
  base: {
    'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';

export interface User {
  id: string;
  status: Status;
}
`,
    'src/dashboard.ts': `import type { Status } from './user.ts';

export function label(status: Status): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
    case 'disabled':
      return 'Disabled';
  }
}
`,
  },
  branchA: {
    'src/user.ts': `export type Status = 'active' | 'suspended';

export interface User {
  id: string;
  status: Status;
}
`,
    'src/dashboard.ts': `import type { Status } from './user.ts';

export function label(status: Status): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
  }
}
`,
  },
  branchB: {
    'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';

export interface User {
  id: string;
  status: Status;
}
`,
    'src/dashboard.ts': `import type { Status } from './user.ts';

export function label(status: Status): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'suspended':
      return 'Suspended';
    case 'disabled':
      return 'Disabled';
  }
}
`,
    'src/audit.ts': `import type { Status } from './user.ts';

export function isBlocked(status: Status): boolean {
  return status === 'disabled';
}
`,
  },
  expect: [
    {
      category: 'literal-set-conflict',
      minSeverity: 'high',
      minConfidence: 'high',
      symbolsInclude: ['Status'],
      mentions: '"disabled"',
    },
  ],
};

const unionMemberRemovedWidened: Fixture = {
  name: 'union-member-removed--widened-consumer',
  summary:
    'Agent A drops "disabled" from Status; Agent B adds a renderer that takes a plain string and compares against "disabled".',
  conflict: true,
  baseline: 'misses',
  note: 'The differentiating case. By the time the value reaches `renderBadge(status: string)` the type system has widened it away, so type-checking the merged tree is clean — the branch simply becomes unreachable. This is the class nothing in the prior art addresses.',
  base: {
    'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';

export interface User {
  id: string;
  status: Status;
}
`,
    'src/render.ts': `import type { User } from './user.ts';

export function renderBadge(status: string): string {
  if (status === 'active') return '<span class="ok" />';
  return '<span class="muted" />';
}

export function renderUser(user: User): string {
  return renderBadge(user.status);
}
`,
  },
  branchA: {
    'src/user.ts': `export type Status = 'active' | 'suspended';

export interface User {
  id: string;
  status: Status;
}
`,
    'src/render.ts': `import type { User } from './user.ts';

export function renderBadge(status: string): string {
  if (status === 'active') return '<span class="ok" />';
  return '<span class="muted" />';
}

export function renderUser(user: User): string {
  return renderBadge(user.status);
}
`,
  },
  branchB: {
    'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';

export interface User {
  id: string;
  status: Status;
}
`,
    'src/render.ts': `import type { User } from './user.ts';

export function renderBadge(status: string): string {
  if (status === 'active') return '<span class="ok" />';
  if (status === 'disabled') return '<span class="danger" />';
  return '<span class="muted" />';
}

export function renderUser(user: User): string {
  return renderBadge(user.status);
}
`,
  },
  expect: [
    {
      category: 'literal-set-conflict',
      minSeverity: 'high',
      minConfidence: 'medium',
      symbolsInclude: ['Status'],
      mentions: '"disabled"',
    },
  ],
};

const propertyRenamed: Fixture = {
  name: 'property-renamed-under-new-reader',
  summary:
    'Agent A renames User.name to User.fullName; Agent B adds a greeting that reads user.name.',
  conflict: true,
  baseline: 'catches',
  base: {
    'src/user.ts': `export interface User {
  id: string;
  name: string;
}

export function load(id: string): User {
  return { id, name: 'anon' };
}
`,
    'src/greet.ts': `import { load } from './user.ts';

export function shortGreeting(id: string): string {
  return 'hi ' + load(id).id;
}
`,
  },
  branchA: {
    'src/user.ts': `export interface User {
  id: string;
  fullName: string;
}

export function load(id: string): User {
  return { id, fullName: 'anon' };
}
`,
    'src/greet.ts': `import { load } from './user.ts';

export function shortGreeting(id: string): string {
  return 'hi ' + load(id).id;
}
`,
  },
  branchB: {
    'src/user.ts': `export interface User {
  id: string;
  name: string;
}

export function load(id: string): User {
  return { id, name: 'anon' };
}
`,
    'src/greet.ts': `import { load } from './user.ts';

export function shortGreeting(id: string): string {
  return 'hi ' + load(id).id;
}

export function longGreeting(id: string): string {
  const user = load(id);
  return 'Welcome back, ' + user.name;
}
`,
  },
  expect: [
    {
      category: 'definition-use-conflict',
      minSeverity: 'high',
      minConfidence: 'high',
      symbolsInclude: ['User'],
      mentions: 'name',
    },
  ],
};

const requiredParameterAdded: Fixture = {
  name: 'required-parameter-added-under-new-caller',
  summary:
    'Agent A makes fetchUser take a required options argument; Agent B adds a caller passing only an id.',
  conflict: true,
  baseline: 'catches',
  base: {
    'src/api.ts': `export interface User { id: string }

export function fetchUser(id: string): User {
  return { id };
}
`,
    'src/page.ts': `import { fetchUser } from './api.ts';

export function show(id: string): string {
  return fetchUser(id).id;
}
`,
  },
  branchA: {
    'src/api.ts': `export interface User { id: string }

export interface FetchOptions { signal: string }

export function fetchUser(id: string, options: FetchOptions): User {
  return { id: id + options.signal };
}
`,
    'src/page.ts': `import { fetchUser } from './api.ts';

export function show(id: string): string {
  return fetchUser(id, { signal: 'none' }).id;
}
`,
  },
  branchB: {
    'src/api.ts': `export interface User { id: string }

export function fetchUser(id: string): User {
  return { id };
}
`,
    'src/page.ts': `import { fetchUser } from './api.ts';

export function show(id: string): string {
  return fetchUser(id).id;
}
`,
    'src/sidebar.ts': `import { fetchUser } from './api.ts';

export function summary(id: string): string {
  return 'user: ' + fetchUser(id).id;
}
`,
  },
  expect: [
    {
      category: 'signature-conflict',
      minSeverity: 'high',
      minConfidence: 'high',
      symbolsInclude: ['fetchUser'],
    },
  ],
};

const exportRemoved: Fixture = {
  name: 'export-removed-under-new-importer',
  summary:
    'Agent A deletes the exported formatDate helper; Agent B adds a module that imports it.',
  conflict: true,
  baseline: 'catches',
  base: {
    'src/format.ts': `export function formatDate(value: number): string {
  return new Date(value).toISOString();
}

export function formatNumber(value: number): string {
  return value.toFixed(2);
}
`,
  },
  branchA: {
    'src/format.ts': `export function formatNumber(value: number): string {
  return value.toFixed(2);
}
`,
  },
  branchB: {
    'src/format.ts': `export function formatDate(value: number): string {
  return new Date(value).toISOString();
}

export function formatNumber(value: number): string {
  return value.toFixed(2);
}
`,
    'src/report.ts': `import { formatDate } from './format.ts';

export function header(at: number): string {
  return 'Generated ' + formatDate(at);
}
`,
  },
  expect: [
    {
      category: 'definition-use-conflict',
      minSeverity: 'high',
      minConfidence: 'high',
      symbolsInclude: ['formatDate'],
    },
  ],
};

const returnBecameNullable: Fixture = {
  name: 'return-became-nullable-under-new-caller',
  summary:
    'Agent A lets findUser return null; Agent B adds a caller that dereferences the result immediately.',
  conflict: true,
  baseline: 'catches',
  base: {
    'src/repo.ts': `export interface User { id: string; email: string }

export function findUser(id: string): User {
  return { id, email: id + '@example.com' };
}
`,
  },
  branchA: {
    'src/repo.ts': `export interface User { id: string; email: string }

export function findUser(id: string): User | null {
  return id === '' ? null : { id, email: id + '@example.com' };
}
`,
  },
  branchB: {
    'src/repo.ts': `export interface User { id: string; email: string }

export function findUser(id: string): User {
  return { id, email: id + '@example.com' };
}
`,
    'src/mailer.ts': `import { findUser } from './repo.ts';

export function addressFor(id: string): string {
  return findUser(id).email;
}
`,
  },
  expect: [
    {
      category: 'signature-conflict',
      minSeverity: 'high',
      symbolsInclude: ['findUser'],
    },
  ],
};

const javascriptConsumer: Fixture = {
  name: 'union-member-removed--javascript-consumer',
  summary:
    'Agent A drops "disabled" from Status; Agent B adds a JavaScript module that branches on "disabled".',
  conflict: true,
  baseline: 'misses',
  note: 'A JavaScript consumer has no types to check, so the merged tree type-checks clean no matter what the union says. Hairline still sees the value and the import path.',
  base: {
    'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';
export const DEFAULT_STATUS: Status = 'active';
`,
    'src/legacy.js': `import { DEFAULT_STATUS } from './user.ts';

export function describe(status) {
  if (status === 'active') return 'Active';
  return 'Unknown ' + DEFAULT_STATUS;
}
`,
  },
  branchA: {
    'src/user.ts': `export type Status = 'active' | 'suspended';
export const DEFAULT_STATUS: Status = 'active';
`,
    'src/legacy.js': `import { DEFAULT_STATUS } from './user.ts';

export function describe(status) {
  if (status === 'active') return 'Active';
  return 'Unknown ' + DEFAULT_STATUS;
}
`,
  },
  branchB: {
    'src/user.ts': `export type Status = 'active' | 'suspended' | 'disabled';
export const DEFAULT_STATUS: Status = 'active';
`,
    'src/legacy.js': `import { DEFAULT_STATUS } from './user.ts';

export function describe(status) {
  if (status === 'active') return 'Active';
  if (status === 'disabled') return 'Disabled';
  return 'Unknown ' + DEFAULT_STATUS;
}
`,
  },
  expect: [
    {
      category: 'literal-set-conflict',
      minConfidence: 'medium',
      symbolsInclude: ['Status'],
      mentions: '"disabled"',
    },
  ],
};

const sameSymbolDivergent: Fixture = {
  name: 'same-symbol-divergent-union',
  summary:
    'Both agents replace "disabled" in the Status union — one with "archived", the other with "banned".',
  conflict: true,
  baseline: 'misses',
  note: 'Both branches edit the same line, but each keeps the file valid, and git may merge without conflict when the edits land in separate hunks. The result silently loses one branch\'s value.',
  base: {
    'src/status.ts': `export type Status = 'active' | 'disabled';

export const ALL: Status[] = ['active', 'disabled'];
`,
  },
  branchA: {
    'src/status.ts': `export type Status = 'active' | 'archived';

export const ALL: Status[] = ['active', 'archived'];
`,
  },
  branchB: {
    'src/status.ts': `export type Status = 'active' | 'banned';

export const ALL: Status[] = ['active', 'banned'];
`,
  },
  gitConflict: true,
  expect: [
    {
      category: 'same-symbol-conflict',
      minSeverity: 'high',
      symbolsInclude: ['Status'],
    },
  ],
};

const defaultValueChanged: Fixture = {
  name: 'default-argument-changed-under-new-caller',
  summary:
    'Agent A changes the default retry count from 3 to 0; Agent B adds callers that rely on the default.',
  conflict: true,
  baseline: 'misses',
  note: 'The signature is byte-identical in type terms — `(url: string, retries?: number)` before and after. No type check and no merge can see this. Reported at low confidence as a risk, never as a proven conflict.',
  base: {
    'src/http.ts': `export function request(url: string, retries: number = 3): string {
  return url + ':' + String(retries);
}
`,
  },
  branchA: {
    'src/http.ts': `export function request(url: string, retries: number = 0): string {
  return url + ':' + String(retries);
}
`,
  },
  branchB: {
    'src/http.ts': `export function request(url: string, retries: number = 3): string {
  return url + ':' + String(retries);
}
`,
    'src/sync.ts': `import { request } from './http.ts';

export function pull(): string {
  return request('/api/sync');
}
`,
  },
  expect: [
    {
      category: 'behavioral-risk',
      minConfidence: 'low',
      symbolsInclude: ['request'],
    },
  ],
};

const lookupTableKey: Fixture = {
  name: 'union-member-removed--lookup-table',
  summary:
    'Agent A drops "disabled" from Status; Agent B adds an entry for it to a Record-keyed lookup table.',
  conflict: true,
  baseline: 'catches',
  base: {
    'src/status.ts': `export type Status = 'active' | 'suspended' | 'disabled';
`,
    'src/labels.ts': `import type { Status } from './status.ts';

export const LABELS: Record<Status, string> = {
  active: 'Active',
  suspended: 'Suspended',
  disabled: 'Disabled',
};
`,
  },
  branchA: {
    'src/status.ts': `export type Status = 'active' | 'suspended';
`,
    'src/labels.ts': `import type { Status } from './status.ts';

export const LABELS: Record<Status, string> = {
  active: 'Active',
  suspended: 'Suspended',
};
`,
  },
  branchB: {
    'src/status.ts': `export type Status = 'active' | 'suspended' | 'disabled';
`,
    'src/labels.ts': `import type { Status } from './status.ts';

export const LABELS: Record<Status, string> = {
  active: 'Active',
  suspended: 'Suspended',
  disabled: 'Disabled',
};
`,
    'src/icons.ts': `import type { Status } from './status.ts';

export const ICONS: Record<Status, string> = {
  active: 'check',
  suspended: 'pause',
  disabled: 'cross',
};
`,
  },
  expect: [
    {
      category: 'literal-set-conflict',
      minConfidence: 'medium',
      symbolsInclude: ['Status'],
    },
  ],
};

// --------------------------------------------------------------------------
// Negative controls: changes that touch the same code and are fine.
// --------------------------------------------------------------------------

const callersUpdated: Fixture = {
  name: 'negative--signature-changed-and-caller-updated',
  summary:
    'Agent A adds a required parameter to fetchUser; Agent B adds a caller that already passes it.',
  conflict: false,
  baseline: 'not-applicable',
  note: 'The restraint case for the signature analyzer: the new call site is compatible with the new signature, so there is nothing to report even though both branches touched related code.',
  base: {
    'src/api.ts': `export interface User { id: string }

export interface FetchOptions { signal: string }

export function fetchUser(id: string, options: FetchOptions): User {
  return { id: id + options.signal };
}
`,
  },
  branchA: {
    'src/api.ts': `export interface User { id: string }

export interface FetchOptions { signal: string }

export function fetchUser(id: string, options: FetchOptions): User {
  return { id: id + options.signal + '!' };
}
`,
  },
  branchB: {
    'src/api.ts': `export interface User { id: string }

export interface FetchOptions { signal: string }

export function fetchUser(id: string, options: FetchOptions): User {
  return { id: id + options.signal };
}
`,
    'src/sidebar.ts': `import { fetchUser } from './api.ts';

export function summary(id: string): string {
  return fetchUser(id, { signal: 'none' }).id;
}
`,
  },
};

const unionMemberAdded: Fixture = {
  name: 'negative--union-member-added',
  summary:
    'Agent A adds "archived" to Status; Agent B adds a consumer handling the values that already existed.',
  conflict: false,
  baseline: 'not-applicable',
  note: 'Widening a union cannot invalidate an existing consumer. A detector that fires on any union change would flag this.',
  base: {
    'src/status.ts': `export type Status = 'active' | 'suspended';
`,
  },
  branchA: {
    'src/status.ts': `export type Status = 'active' | 'suspended' | 'archived';
`,
  },
  branchB: {
    'src/status.ts': `export type Status = 'active' | 'suspended';
`,
    'src/audit.ts': `import type { Status } from './status.ts';

export function isLive(status: Status): boolean {
  return status === 'active';
}
`,
  },
};

const adjacentEdits: Fixture = {
  name: 'negative--adjacent-edits-same-file',
  summary:
    'Both agents add a different function to the same module, touching neighbouring lines.',
  conflict: false,
  baseline: 'not-applicable',
  note: 'Same file, same module, no shared contract. Purely textual proximity must not produce a finding.',
  base: {
    'src/math.ts': `export function add(a: number, b: number): number {
  return a + b;
}

export function negate(value: number): number {
  return -value;
}

export function identity(value: number): number {
  return value;
}
`,
  },
  branchA: {
    'src/math.ts': `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function negate(value: number): number {
  return -value;
}

export function identity(value: number): number {
  return value;
}
`,
  },
  branchB: {
    'src/math.ts': `export function add(a: number, b: number): number {
  return a + b;
}

export function negate(value: number): number {
  return -value;
}

export function identity(value: number): number {
  return value;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
  },
};

const optionalMemberAdded: Fixture = {
  name: 'negative--optional-member-added',
  summary:
    'Agent A adds an optional field to User; Agent B adds code constructing a User without it.',
  conflict: false,
  baseline: 'not-applicable',
  base: {
    'src/user.ts': `export interface User {
  id: string;
}
`,
  },
  branchA: {
    'src/user.ts': `export interface User {
  id: string;
  nickname?: string;
}
`,
  },
  branchB: {
    'src/user.ts': `export interface User {
  id: string;
}
`,
    'src/factory.ts': `import type { User } from './user.ts';

export function make(id: string): User {
  return { id };
}
`,
  },
};

const unrelatedModules: Fixture = {
  name: 'negative--unrelated-modules',
  summary: 'The two agents work on modules with no import path between them.',
  conflict: false,
  baseline: 'not-applicable',
  note: 'Exercises the pair-pruning path: the engine should record that these branches cannot interact, rather than running every analyzer over them.',
  base: {
    'src/billing.ts': `export function invoice(total: number): string {
  return 'INV-' + String(total);
}
`,
    'src/search.ts': `export function query(term: string): string[] {
  return [term];
}
`,
  },
  branchA: {
    'src/billing.ts': `export function invoice(total: number, currency: string): string {
  return currency + '-INV-' + String(total);
}
`,
    'src/search.ts': `export function query(term: string): string[] {
  return [term];
}
`,
  },
  branchB: {
    'src/billing.ts': `export function invoice(total: number): string {
  return 'INV-' + String(total);
}
`,
    'src/search.ts': `export function query(term: string, limit: number): string[] {
  return [term].slice(0, limit);
}
`,
  },
};

const reformatOnly: Fixture = {
  name: 'negative--reformat-versus-real-change',
  summary:
    'Agent A reformats a module and adds documentation; Agent B adds a caller of the untouched function.',
  conflict: false,
  baseline: 'not-applicable',
  note: 'Guards the change model: formatting must not register as a contract change, or every prettier run would light up the report.',
  base: {
    'src/util.ts': `export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`,
  },
  branchA: {
    'src/util.ts': `/**
 * Clamp a value into an inclusive range.
 *
 * @param value the number to clamp
 */
export function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(
    Math.max(value, min),
    max,
  );
}
`,
  },
  branchB: {
    'src/util.ts': `export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`,
    'src/volume.ts': `import { clamp } from './util.ts';

export function setVolume(level: number): number {
  return clamp(level, 0, 100);
}
`,
  },
};

const renamedAndUpdated: Fixture = {
  name: 'negative--renamed-with-all-consumers-updated',
  summary:
    'Agent A renames a helper and updates its only caller; Agent B works in a module that never used it.',
  conflict: false,
  baseline: 'not-applicable',
  base: {
    'src/text.ts': `export function trimAll(value: string): string {
  return value.trim();
}
`,
    'src/form.ts': `import { trimAll } from './text.ts';

export function normalise(value: string): string {
  return trimAll(value);
}
`,
    'src/colour.ts': `export function hex(value: number): string {
  return '#' + value.toString(16);
}
`,
  },
  branchA: {
    'src/text.ts': `export function trimWhitespace(value: string): string {
  return value.trim();
}
`,
    'src/form.ts': `import { trimWhitespace } from './text.ts';

export function normalise(value: string): string {
  return trimWhitespace(value);
}
`,
    'src/colour.ts': `export function hex(value: number): string {
  return '#' + value.toString(16);
}
`,
  },
  branchB: {
    'src/text.ts': `export function trimAll(value: string): string {
  return value.trim();
}
`,
    'src/form.ts': `import { trimAll } from './text.ts';

export function normalise(value: string): string {
  return trimAll(value);
}
`,
    'src/colour.ts': `export function hex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}
`,
  },
};

const bodyChangeNoNewConsumer: Fixture = {
  name: 'negative--implementation-changed-no-new-consumer',
  summary:
    'Agent A rewrites a function body; Agent B adds an unrelated function in another module.',
  conflict: false,
  baseline: 'not-applicable',
  note: 'A body change on its own is ordinary work. If this produced a finding, every concurrent pair of branches in a normal week would.',
  base: {
    'src/price.ts': `export function total(subtotal: number): number {
  return subtotal * 1.1;
}
`,
  },
  branchA: {
    'src/price.ts': `export function total(subtotal: number): number {
  const rate = 1.1;
  return Math.round(subtotal * rate * 100) / 100;
}
`,
  },
  branchB: {
    'src/price.ts': `export function total(subtotal: number): number {
  return subtotal * 1.1;
}
`,
    'src/currency.ts': `export function symbol(code: string): string {
  return code === 'USD' ? '$' : code;
}
`,
  },
};

export const CORPUS: readonly Fixture[] = [
  unionMemberRemovedTyped,
  unionMemberRemovedWidened,
  propertyRenamed,
  requiredParameterAdded,
  exportRemoved,
  returnBecameNullable,
  javascriptConsumer,
  sameSymbolDivergent,
  defaultValueChanged,
  lookupTableKey,
  callersUpdated,
  unionMemberAdded,
  adjacentEdits,
  optionalMemberAdded,
  unrelatedModules,
  reformatOnly,
  renamedAndUpdated,
  bodyChangeNoNewConsumer,
];

export function fixtureByName(name: string): Fixture | undefined {
  return CORPUS.find((f) => f.name === name);
}
