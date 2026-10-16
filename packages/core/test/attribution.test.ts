import { isInterlockError, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  Finding,
  ProcessOutputEvidence,
  SpanEvidence,
  SpeculativeRunId,
  SymbolTrailStep,
} from '@interlock/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTED_CONFIDENCE,
  ATTRIBUTION_RULES,
  MAX_PARSED_BYTES,
  MAX_SCANNED_FILES,
  TSC_ERROR_EXIT,
  UNATTRIBUTED_CONFIDENCE,
  UNATTRIBUTED_RATIONALES,
  attributeDiagnostics,
} from '../src/analyzers/attribution.js';
import type { UnattributedReason } from '../src/analyzers/attribution.js';
import { createTypecheckRegistry } from '../src/analyzers/typecheck.js';
import type { FileDiagnostic, TypecheckRegistry } from '../src/analyzers/typecheck.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  MAX_FINDINGS_PER_RUN,
  MAX_SPANS_PER_SIDE,
} from '../src/merge/conflict-classifier.js';
import {
  CHECKOUT,
  NO_CHANGE,
  PAYMENTS,
  PROJECT,
  SEMANTIC_CASES,
  attributionFixtures,
  lines,
} from './support/attribution-fixtures.js';
import type { AttributionFixtures, BranchSpec, Pair } from './support/attribution-fixtures.js';

/**
 * Attribution against real pairs: repositories built in temporary directories,
 * merged in their shadows, each side's ChangeSet extracted as the watcher
 * extracts it, and — wherever the compiler can produce one — the diagnostic
 * the type-check service reports for the merged slot.
 */

let registry: TypecheckRegistry;
let fixtures: AttributionFixtures;

beforeAll(() => {
  registry = createTypecheckRegistry();
});
afterAll(async () => {
  await registry.close();
});
beforeEach(() => {
  fixtures = attributionFixtures();
});
afterEach(() => {
  fixtures.dispose();
});

/** Repository content that must never reach a field the CLI prints unwrapped. */
const NAMES = ['processRefund', 'refundPayment', 'formatPrice', 'slugify', 'Ledger', 'src/'];

function only(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  for (const field of [finding!.title, finding!.description, finding!.attribution.rationale]) {
    for (const name of NAMES) expect(field).not.toContain(name);
  }
  return finding!;
}

function spans(
  finding: Finding,
  branch: BranchRefId,
): Pick<SpanEvidence, 'path' | 'startLine' | 'endLine'>[] {
  return finding.evidence
    .filter((item): item is SpanEvidence => item.type === 'span' && item.branchRefId === branch)
    .map(({ path, startLine, endLine }) => ({ path, startLine, endLine }));
}

function trail(finding: Finding): readonly SymbolTrailStep[] {
  const evidence = finding.evidence.find((item) => item.type === 'symbol-trail');
  return evidence?.type === 'symbol-trail' ? evidence.steps : [];
}

function toolOutput(finding: Finding): ProcessOutputEvidence {
  const evidence = finding.evidence.find((item) => item.type === 'process-output');
  if (evidence?.type !== 'process-output') throw new Error('no process output');
  return evidence;
}

function expectUnattributed(finding: Finding, reason: UnattributedReason): void {
  expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
  expect(finding.attribution.originBranch).toBeNull();
  expect(finding.confidence).toBe(UNATTRIBUTED_CONFIDENCE);
  // Lower than an attributed Finding's, whatever the constants are set to.
  expect(finding.confidence).toBeLessThan(ATTRIBUTED_CONFIDENCE);
  expect(finding.attribution.rationale).toBe(UNATTRIBUTED_RATIONALES[reason]);
  // Never nothing: the compiler's output is evidence however little else is known.
  expect(toolOutput(finding).exitCode).toBe(TSC_ERROR_EXIT);
}

/** The eval rename case, which most of the cases here vary. */
const rename = SEMANTIC_CASES.find((each) => each.id === 'rename-vs-callsite')!;

/** `src/support.ts` calling `processRefund` through a named import, as the eval case adds it. */
const SUPPORT = lines(
  'import { processRefund } from "./payments";',
  '',
  'export function escalate(orderId: string): string {',
  '  return processRefund(orderId);',
  '}',
);

const write = (path: string, content: string): BranchSpec['committed'][number] => ({
  op: 'write',
  path,
  content,
});
const committed = (...operations: BranchSpec['committed']): BranchSpec => ({
  committed: operations,
  uncommitted: [],
});

async function checkedPair(
  base: Record<string, string>,
  a: BranchSpec,
  b: BranchSpec,
): Promise<Pair> {
  return fixtures.pair(base, a, b, { registry });
}

describe("the evaluation suite's typecheck cases", () => {
  const actions: Readonly<Record<string, SymbolTrailStep['action']>> = {
    'rename-vs-callsite': 'renamed',
    'signature-vs-caller': 'signature-changed',
    'moved-export-vs-import': 'moved',
  };
  // A label marks the reference from its first line to its last. The lines of
  // it that are the reference — a stale import's import and its use — are
  // spans of their own, which together reach both ends of the label.
  const referenceLines: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
    'rename-vs-callsite': [
      [1, 1],
      [4, 4],
    ],
    'signature-vs-caller': [[4, 4]],
    'moved-export-vs-import': [
      [1, 1],
      [4, 4],
    ],
  };

  for (const fixture of SEMANTIC_CASES.filter((each) => each.twinOf === null)) {
    it(`attributes ${fixture.id} as its label says`, async () => {
      const pair = await checkedPair(fixture.base, fixture.a, fixture.b);
      expect(pair.diagnostics).toHaveLength(1);
      const { findings, dropped } = await pair.attribute();
      expect(dropped).toBe(0);
      const finding = only(findings);
      const label = fixture.expected[0]!;

      expect(finding.kind).toBe('typecheck');
      expect(finding.rule).toBe(label.class);
      expect(finding.severity).toBe('high');
      expect(finding.confidence).toBe(1);
      expect(finding.attribution.originBranch).toBe(pair.branchA);
      expect(spans(finding, pair.branchA)).toEqual([
        { path: label.spanA!.path, startLine: label.spanA!.start, endLine: label.spanA!.end },
      ]);
      const onB = spans(finding, pair.branchB);
      expect(onB).toEqual(
        referenceLines[fixture.id]!.map(([startLine, endLine]) => ({
          path: label.spanB!.path,
          startLine,
          endLine,
        })),
      );
      expect([onB[0]!.startLine, onB.at(-1)!.endLine]).toEqual([
        label.spanB!.start,
        label.spanB!.end,
      ]);
      expect(
        trail(finding).map(({ branchRefId, symbol, action }) => ({ branchRefId, symbol, action })),
      ).toEqual([
        { branchRefId: pair.branchA, symbol: label.symbol, action: actions[label.class] },
        { branchRefId: pair.branchB, symbol: label.symbol, action: 'referenced' },
      ]);
      const output = toolOutput(finding);
      expect(output.exitCode).toBe(TSC_ERROR_EXIT);
      expect(output.locations).toEqual([
        { path: label.path, line: pair.diagnostics[0]!.line, column: pair.diagnostics[0]!.column },
      ]);
      expect(output.output).toContain(`TS${String(pair.diagnostics[0]!.code)}`);
    });
  }

  for (const twin of SEMANTIC_CASES.filter((each) => each.twinOf !== null)) {
    it(`is never asked about ${twin.id}: the merged tree compiles`, async () => {
      const pair = await checkedPair(twin.base, twin.a, twin.b);
      expect(pair.diagnostics).toEqual([]);
      expect((await pair.attribute()).findings).toEqual([]);
    });
  }
});

describe("each branch's own lines", () => {
  /** A ledger long enough that git still calls it renamed after one line changes. */
  const LEDGER = lines(
    'export function processRefund(orderId: string): string {',
    '  return `refund:${orderId}`;',
    '}',
    '',
    'export function chargeCard(orderId: string, cents: number): string {',
    '  return `charge:${orderId}:${String(cents)}`;',
    '}',
    '',
    'export function voidCharge(orderId: string): string {',
    '  return `void:${orderId}`;',
    '}',
    '',
    'export function settleBatch(batchId: string): string {',
    '  return `settle:${batchId}`;',
    '}',
  );
  const ESCALATE = lines(
    '',
    'export function escalate(orderId: string): string {',
    '  return processRefund(orderId);',
    '}',
  );
  const HEADER = '// Refunds go through the provider.\n// Amounts are in cents.\n';

  it('places a reference in a file both branches edited in the referencing branch', async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS },
      committed(
        write('src/payments.ts', HEADER + PAYMENTS.replace('processRefund', 'refundPayment')),
      ),
      committed(write('src/payments.ts', PAYMENTS + ESCALATE)),
    );
    const [diagnostic] = pair.diagnostics;
    expect(pair.diagnostics).toHaveLength(1);
    // Merged, the call sits under both the header and the call's own lines.
    expect(diagnostic!.line).toBe(8);

    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 3, endLine: 3 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 6, endLine: 6 },
    ]);
    expect(trail(finding).map((step) => step.location)).toEqual([
      { path: 'src/payments.ts', line: 3, column: 17 },
      { path: 'src/payments.ts', line: 6, column: null },
    ]);
  });

  it("names the referencing branch's own path when the declaring branch renamed the file", async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': LEDGER },
      {
        committed: [
          { op: 'rename', from: 'src/payments.ts', to: 'src/billing.ts' },
          write('src/billing.ts', HEADER + LEDGER.replace('processRefund', 'refundPayment')),
        ],
        uncommitted: [],
      },
      committed(write('src/payments.ts', LEDGER + ESCALATE)),
    );
    expect(pair.changeSetA.files).toContainEqual(
      expect.objectContaining({
        kind: 'renamed',
        path: 'src/billing.ts',
        previousPath: 'src/payments.ts',
      }),
    );
    const [diagnostic] = pair.diagnostics;
    expect(pair.diagnostics).toHaveLength(1);
    expect(diagnostic!.file).toBe('src/billing.ts');
    expect(diagnostic!.line).toBe(20);

    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/billing.ts', startLine: 3, endLine: 3 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 18, endLine: 18 },
    ]);
  });

  it('reads a ChangeSet against its own base when that is not the pair merge base', async () => {
    // The default branch puts five lines above the declaration after `a`
    // forks, and `b` forks from there and edits one of them. In `b`'s base the
    // declaration sits at lines 9–11 and `b`'s hunk at line 4; read in the
    // pair base's lines, 4–6, the hunk would cross it and both branches would
    // seem to have changed it.
    const prefix = lines('// Payments.', '', '');
    const owned = lines('// Owned by billing.', '// -', '// -', '// -', '// -');
    const reviewed = lines('// Owned by billing.', '// -', '// -', '// reviewed', '// -');
    const pair = await fixtures.pair(
      { ...PROJECT, 'src/payments.ts': prefix + PAYMENTS, 'src/checkout.ts': CHECKOUT },
      committed(
        write('src/payments.ts', prefix + PAYMENTS.replace('processRefund', 'refundPayment')),
        write('src/checkout.ts', CHECKOUT.replaceAll('processRefund', 'refundPayment')),
      ),
      {
        committed: [write('src/payments.ts', reviewed + prefix + PAYMENTS)],
        uncommitted: [write('src/support.ts', SUPPORT)],
      },
      { registry, forkB: committed(write('src/payments.ts', owned + prefix + PAYMENTS)) },
    );
    expect(pair.changeSetB.mergeBaseSha).not.toBe(pair.merge.mergeBaseSha);
    expect(pair.changeSetB.files).toContainEqual(
      expect.objectContaining({
        path: 'src/payments.ts',
        hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }],
      }),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 4, endLine: 4 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 1 },
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });
});

describe('references', () => {
  it('follows an aliased import to the name it imports', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import { processRefund as refund } from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return refund(orderId);',
            '}',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 1 },
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
    expect(trail(finding).map((step) => step.symbol)).toEqual(['processRefund', 'processRefund']);
  });

  it("reads a namespace import's property as that module's export", async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import * as payments from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return payments.processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    expect(pair.diagnostics).toHaveLength(1);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });

  it('finds a renamed method as the one member of that name either branch changed', async () => {
    const ledger = lines(
      'export class Ledger {',
      '  processRefund(orderId: string): string {',
      '    return `refund:${orderId}`;',
      '  }',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/ledger.ts': ledger },
      committed(write('src/ledger.ts', ledger.replace('processRefund', 'refundPayment'))),
      committed(
        write(
          'src/support.ts',
          lines(
            'import { Ledger } from "./ledger";',
            '',
            'export function escalate(ledger: Ledger, orderId: string): string {',
            '  return ledger.processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/ledger.ts', startLine: 2, endLine: 2 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });

  it('names a removal under the generic rule, with an empty span where it was', async () => {
    const settle = lines(
      'export function settleBatch(batchId: string): string {',
      '  return batchId;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': `${PAYMENTS}\n${settle}` },
      committed(write('src/payments.ts', settle)),
      committed(write('src/support.ts', SUPPORT)),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.confidence).toBe(1);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 1, endLine: 0 },
    ]);
    expect(trail(finding).map((step) => step.action)).toEqual(['deleted', 'referenced']);
  });

  it('attributes too many arguments, reported over the extra one, to the changed signature', async () => {
    const format = lines(
      'export function formatPrice(amount: number, currency: string): string {',
      '  return `${currency} ${amount.toFixed(2)}`;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/format.ts': format },
      committed(
        write(
          'src/format.ts',
          lines(
            'export function formatPrice(amount: number): string {',
            '  return amount.toFixed(2);',
            '}',
          ),
        ),
      ),
      committed(
        write(
          'src/invoice.ts',
          lines(
            'import { formatPrice } from "./format";',
            '',
            'export function line(amount: number): string {',
            '  return formatPrice(',
            '    amount,',
            '    "EUR",',
            '  );',
            '}',
          ),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => [each.code, each.line])).toEqual([[2554, 6]]);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.signature);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/invoice.ts', startLine: 4, endLine: 7 },
    ]);
  });

  it('names a removal, not a rename, when two declarations took its place', async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS },
      committed(
        write(
          'src/payments.ts',
          lines(
            'export function refundPayment(orderId: string): string {',
            '  return `refund:${orderId}`;',
            '}',
            '',
            'export function refundCard(cardId: string): string {',
            '  return `card:${cardId}`;',
            '}',
          ),
        ),
      ),
      committed(write('src/support.ts', SUPPORT)),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(trail(finding).map((step) => step.action)).toEqual(['deleted', 'referenced']);
  });

  it('names no move when the export turns up in two new modules', async () => {
    const moved = SEMANTIC_CASES.find((each) => each.id === 'moved-export-vs-import')!;
    const slugify = moved.a.committed.find(
      (operation) => operation.op === 'write' && operation.path === 'src/strings.ts',
    )!;
    const pair = await checkedPair(
      moved.base,
      committed(
        ...moved.a.committed,
        write('src/text.ts', slugify.op === 'write' ? slugify.content : ''),
      ),
      moved.b,
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
  });

  it('spans a stale import from its first line when the name sits on a later one', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import {',
            '  processRefund,',
            '} from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => each.line)).toEqual([2]);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 3 },
      { path: 'src/support.ts', startLine: 6, endLine: 6 },
    ]);
  });

  it('keeps a path holding a space as the path', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(write('src/my support.ts', SUPPORT)),
    );
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/my support.ts', startLine: 1, endLine: 1 },
      { path: 'src/my support.ts', startLine: 4, endLine: 4 },
    ]);
  });
});

describe('when it cannot tell, it names no branch', () => {
  it('when both branches changed the declaration', async () => {
    const declaration = lines(
      'export function processRefund(',
      '  orderId: string,',
      '): string {',
      '  const id = orderId.trim();',
      '  return `refund:${id}`;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': declaration },
      committed(write('src/payments.ts', declaration.replace('processRefund', 'refundPayment'))),
      committed(
        write('src/payments.ts', declaration.replace('`refund:${id}`', '`refund:${id}:queued`')),
        write('src/support.ts', SUPPORT),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expectUnattributed(finding, 'both-changed-declaration');
    // What is known still stands: the reference is on the branch that holds it.
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 1 },
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });

  it('when the reference was already in the merge base', async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS, 'src/checkout.ts': CHECKOUT },
      committed(write('src/payments.ts', PAYMENTS.replace('processRefund', 'refundPayment'))),
      committed(write('src/other.ts', 'export const other = 1;\n')),
    );
    expect(pair.diagnostics.map((each) => each.file)).toEqual(['src/checkout.ts']);
    expectUnattributed(only((await pair.attribute()).findings), 'reference-in-base');

    // A ChangeSet claiming to have written that unchanged file is believed of nothing.
    const claimed = {
      path: 'src/checkout.ts',
      previousPath: null,
      kind: 'modified' as const,
      hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }],
      symbols: [],
      binary: false,
    };
    expectUnattributed(
      only(
        (
          await pair.attribute({
            changeSetB: { ...pair.changeSetB, files: [...pair.changeSetB.files, claimed] },
          })
        ).findings,
      ),
      'stale-change-set',
    );
  });

  it("when the diagnostic's code is not one it reads", async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const diagnostic = { ...pair.diagnostics[0]!, code: 2322 };
    const finding = only((await pair.attribute({ diagnostics: [diagnostic] })).findings);
    expectUnattributed(finding, 'unrecognised-code');
    expect(finding.evidence.map((item) => item.type)).toEqual(['process-output']);
  });

  it('when a ChangeSet is missing, or is another branch’s', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    expectUnattributed(
      only((await pair.attribute({ changeSetB: null })).findings),
      'missing-change-set',
    );
    expectUnattributed(
      only((await pair.attribute({ changeSetA: null })).findings),
      'missing-change-set',
    );
    expectUnattributed(
      only((await pair.attribute({ changeSetA: pair.changeSetB })).findings),
      'missing-change-set',
    );
  });

  it('when a ChangeSet describes some other commit than the one merged', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    // As a ChangeSet captured before either branch wrote anything reads.
    expectUnattributed(
      only((await pair.attribute({ changeSetA: { ...pair.changeSetA, files: [] } })).findings),
      'stale-change-set',
    );
    expectUnattributed(
      only((await pair.attribute({ changeSetB: { ...pair.changeSetB, files: [] } })).findings),
      'stale-change-set',
    );
  });

  it('when the import is bare, and resolving it would need the project', async () => {
    const tsconfig = PROJECT['tsconfig.json']!.replace(
      '"moduleResolution": "bundler"',
      '"moduleResolution": "bundler",\n    "paths": { "@/*": ["./src/*"] }',
    );
    const pair = await checkedPair(
      { ...rename.base, 'tsconfig.json': tsconfig },
      rename.a,
      committed(write('src/support.ts', SUPPORT.replace('"./payments"', '"@/payments"'))),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2305]);
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it('when the file holding the reference is past the parse cap, and not at it', async () => {
    // ASCII, so characters are bytes: the file is exactly `size` bytes long.
    const sized = (size: number): string =>
      `${SUPPORT}// ${'x'.repeat(size - SUPPORT.length - 4)}\n`;
    expect(sized(MAX_PARSED_BYTES)).toHaveLength(MAX_PARSED_BYTES);

    const over = await checkedPair(
      rename.base,
      rename.a,
      committed(write('src/support.ts', sized(MAX_PARSED_BYTES + 1))),
    );
    expect(over.diagnostics.map((each) => each.code)).toEqual([2305]);
    expectUnattributed(only((await over.attribute()).findings), 'unreadable-location');

    const at = await checkedPair(
      rename.base,
      rename.a,
      committed(write('src/support.ts', sized(MAX_PARSED_BYTES))),
    );
    const finding = only((await at.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(at.branchA);
  });

  it('when the diagnostic is not where it says it is', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const [diagnostic] = pair.diagnostics;
    for (const moved of [
      { ...diagnostic!, column: diagnostic!.column + 1 },
      { ...diagnostic!, start: diagnostic!.start + 1, column: diagnostic!.column + 1 },
      { ...diagnostic!, start: 1_000_000 },
      { ...diagnostic!, file: 'node_modules/typescript/lib/lib.d.ts' },
      // Where the name starts, and shorter than it: some other text than the name.
      { ...diagnostic!, length: 5 },
    ]) {
      expectUnattributed(
        only((await pair.attribute({ diagnostics: [moved] })).findings),
        'unreadable-location',
      );
    }
  });

  it('when the file nests deeper than the parser holds, without failing the batch', async () => {
    // The compiler overflows on this too, so the diagnostic is written by hand.
    const deep = `import { processRefund } from "./payments";\nexport const x = ${'['.repeat(1000)}1${']'.repeat(1000)};\n`;
    const pair = await fixtures.pair(rename.base, rename.a, committed(write('src/deep.ts', deep)));
    const diagnostic: FileDiagnostic = {
      code: 2305,
      category: 'error',
      message: "Module '\"./payments\"' has no exported member 'processRefund'.",
      file: 'src/deep.ts',
      start: 9,
      length: 13,
      line: 1,
      column: 10,
    };
    expectUnattributed(
      only((await pair.attribute({ diagnostics: [diagnostic] })).findings),
      'unreadable-location',
    );
  });

  it('when the branch that changed the declaration also added the reference', async () => {
    const pair = await checkedPair(
      rename.base,
      committed(...rename.a.committed, write('src/support.ts', SUPPORT)),
      committed(write('src/other.ts', 'export const other = 1;\n')),
    );
    expectUnattributed(only((await pair.attribute()).findings), 'same-branch');
  });

  it('when both branches added the reference', async () => {
    const pair = await checkedPair(
      rename.base,
      committed(...rename.a.committed, write('src/support.ts', SUPPORT)),
      committed(write('src/support.ts', SUPPORT)),
    );
    expectUnattributed(only((await pair.attribute()).findings), 'both-hold-reference');
  });

  it('when the branch that changed the declaration still has it as the diagnostic needs', async () => {
    // `a` reformats the function and `b` calls it with too few arguments: the
    // arity was never `a`'s to break.
    const format = lines(
      'export function formatPrice(amount: number, currency: string): string {',
      '  return `${currency} ${amount.toFixed(2)}`;',
      '}',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/format.ts': format },
      committed(write('src/format.ts', format.replace('return `', 'return  `'))),
      committed(
        write(
          'src/invoice.ts',
          lines('import { formatPrice } from "./format";', 'export const total = formatPrice(1);'),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2554]);
    expectUnattributed(only((await pair.attribute()).findings), 'change-does-not-explain');
  });

  it("when a branch's file is too far from the merged one to place the line, widening its span", async () => {
    const filler = Array.from({ length: 1100 }, (_, index) => `// note ${String(index)}`).join(
      '\n',
    );
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': PAYMENTS },
      committed(
        write(
          'src/payments.ts',
          `${filler}\n${PAYMENTS.replace('processRefund', 'refundPayment')}`,
        ),
      ),
      committed(
        write(
          'src/payments.ts',
          PAYMENTS +
            lines(
              '',
              'export function escalate(orderId: string): string {',
              '  return processRefund(orderId);',
              '}',
            ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expectUnattributed(finding, 'mapping-unsure');
    // Where `b` wrote in the file, the call among it — not a line it cannot vouch for.
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 4, endLine: 7 },
    ]);
  });

  it('when a ChangeSet says a file was added that its base already had', async () => {
    const pair = await checkedPair(
      { ...rename.base, 'src/support.ts': 'export const support = 1;\n' },
      rename.a,
      committed(write('src/support.ts', SUPPORT)),
    );
    expect(only((await pair.attribute()).findings).attribution.originBranch).toBe(pair.branchA);
    const forged = {
      ...pair.changeSetB,
      files: pair.changeSetB.files.map((file) => ({ ...file, kind: 'added' as const })),
    };
    expectUnattributed(
      only((await pair.attribute({ changeSetB: forged })).findings),
      'stale-change-set',
    );
  });

  it('when the member a property names is declared in more than one changed file', async () => {
    const member = (container: string): string =>
      lines(
        `export class ${container} {`,
        '  processRefund(orderId: string): string {',
        '    return orderId;',
        '  }',
        '}',
      );
    const pair = await checkedPair(
      { ...PROJECT, 'src/ledger.ts': member('Ledger'), 'src/wallet.ts': member('Wallet') },
      committed(
        write('src/ledger.ts', member('Ledger').replace('processRefund', 'refundPayment')),
        write('src/wallet.ts', `// Wallets refund through the ledger.\n${member('Wallet')}`),
      ),
      committed(
        write(
          'src/support.ts',
          lines(
            'import { Ledger } from "./ledger";',
            '',
            'export const escalate = (ledger: Ledger, id: string): string =>',
            '  ledger.processRefund(id);',
          ),
        ),
      ),
    );
    expect(pair.diagnostics).toHaveLength(1);
    // Which class `ledger` is needs a program; two candidates is a guess.
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it('when the member search would read more changed files than its bound', async () => {
    const ledger = lines(
      'export class Ledger {',
      '  processRefund(orderId: string): string {',
      '    return orderId;',
      '  }',
      '}',
    );
    const extras = Object.fromEntries(
      Array.from({ length: MAX_SCANNED_FILES }, (_, index) => [
        `src/extra-${String(index)}.ts`,
        `export const extra${String(index)} = ${String(index)};\n`,
      ]),
    );
    const pair = await checkedPair(
      { ...PROJECT, ...extras, 'src/ledger.ts': ledger },
      committed(
        write('src/ledger.ts', ledger.replace('processRefund', 'refundPayment')),
        ...Object.keys(extras).map((path) => write(path, `${extras[path]!}// touched\n`)),
      ),
      committed(
        write(
          'src/support.ts',
          lines(
            'import { Ledger } from "./ledger";',
            '',
            'export const escalate = (ledger: Ledger, id: string): string =>',
            '  ledger.processRefund(id);',
          ),
        ),
      ),
    );
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it('when a call names something whose parameters only a program could read', async () => {
    const typed = (parameters: string, body: string): string =>
      lines(
        `const make = () => (${parameters}) => ${body};`,
        `export const formatPrice: (${parameters}) => string = make();`,
      );
    const pair = await checkedPair(
      { ...PROJECT, 'src/format.ts': typed('amount: number', 'amount.toFixed(2)') },
      committed(
        write(
          'src/format.ts',
          typed('amount: number, currency: string', '`${currency} ${amount.toFixed(2)}`'),
        ),
      ),
      committed(
        write(
          'src/invoice.ts',
          lines('import { formatPrice } from "./format";', 'export const total = formatPrice(1);'),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2554]);
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it('when the declaring branch only renamed the file, which leaves the name where it was', async () => {
    const ledger = lines(
      'export function processRefund(orderId: string): string {',
      '  return `refund:${orderId}`;',
      '}',
      '',
      'export function settleBatch(batchId: string): string {',
      '  return `settle:${batchId}`;',
      '}',
    );
    const escalate = lines(
      '',
      'export function escalate(orderId: string): string {',
      '  return processRefund(orderId);',
      '}',
    );
    const pair = await fixtures.pair(
      { ...PROJECT, 'src/payments.ts': ledger },
      {
        committed: [{ op: 'rename', from: 'src/payments.ts', to: 'src/billing.ts' }],
        uncommitted: [],
      },
      committed(write('src/payments.ts', ledger + escalate)),
    );
    // The merge compiles; a diagnostic at the call is made up to ask about
    // the one branch that touched the declaration only by moving its file.
    const merged = ledger + escalate;
    const start = merged.indexOf('processRefund(orderId);');
    const diagnostic: FileDiagnostic = {
      code: 2304,
      category: 'error',
      message: "Cannot find name 'processRefund'.",
      file: 'src/billing.ts',
      start,
      length: 'processRefund'.length,
      line: 10,
      column: 10,
    };
    expectUnattributed(
      only((await pair.attribute({ diagnostics: [diagnostic] })).findings),
      'change-does-not-explain',
    );
  });
});

describe('evidence', () => {
  it('keeps an excerpt redacted and short, whatever the reference file holds', async () => {
    const token = `ghp_${'a1b2c3d4e5'.repeat(4)}`;
    const noise = Array.from(
      { length: 20 },
      (_, index) => `// \u001b[2J\u001b[31m line ${String(index)} ${'y'.repeat(80)}`,
    );
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            // The import is the span, so what the excerpt is cut from is inside it.
            'import {',
            `  // ${token}`,
            ...noise,
            '  processRefund,',
            '} from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    const span = finding.evidence.find(
      (item): item is SpanEvidence => item.type === 'span' && item.branchRefId === pair.branchB,
    )!;
    expect(span.startLine).toBe(1);
    expect(span.endLine).toBe(24);
    expect(span.excerpt).not.toContain(token);
    expect(span.excerpt).toContain('[redacted]');
    expect(span.excerpt.split('\n').length).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
    expect([...span.excerpt].length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });

  it("redacts the compiler's output", async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const token = `ghp_${'a1b2c3d4e5'.repeat(4)}`;
    const diagnostic = { ...pair.diagnostics[0]!, message: `has no exported member ${token}` };
    const output = toolOutput(only((await pair.attribute({ diagnostics: [diagnostic] })).findings));
    expect(output.output).not.toContain(token);
    expect(output.output).toContain('[redacted]');
  });
});

describe('the batch', () => {
  it('attributes at most the bound and counts the rest', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const diagnostics = Array.from(
      { length: MAX_FINDINGS_PER_RUN + 3 },
      () => pair.diagnostics[0]!,
    );
    const { findings, dropped } = await pair.attribute({ diagnostics });
    expect(findings).toHaveLength(MAX_FINDINGS_PER_RUN);
    expect(dropped).toBe(3);
  });

  it('stops with REQUEST_CANCELLED once its signal is aborted', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const controller = new AbortController();
    controller.abort();
    const attempt = attributeDiagnostics(
      {
        runId: ulid<SpeculativeRunId>(),
        branchA: pair.branchA,
        branchB: pair.branchB,
        changeSetA: pair.changeSetA,
        changeSetB: pair.changeSetB,
        merge: pair.merge,
        mergedTreeOid: pair.merged.treeOid,
        diagnostics: pair.diagnostics,
        now: new Date().toISOString(),
      },
      { runner: createGitRunner(), signal: controller.signal },
    );
    await expect(attempt).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('throws the runner’s infrastructure error rather than make a Finding from nothing', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const error: unknown = await pair.attribute({ mergedTreeOid: '0'.repeat(40) }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isInterlockError(error) && error.infra).toBe(true);
  });

  it('looks for a move in no more changed files than its bound', async () => {
    const extra = Array.from({ length: MAX_SCANNED_FILES }, (_, index) =>
      write(
        `src/extra-${String(index)}.ts`,
        `export const extra${String(index)} = ${String(index)};\n`,
      ),
    );
    const moved = SEMANTIC_CASES.find((each) => each.id === 'moved-export-vs-import')!;
    const pair = await checkedPair(moved.base, committed(...moved.a.committed, ...extra), moved.b);
    const finding = only((await pair.attribute()).findings);
    // Past the bound the move is not found: the narrower rule is lost, never the branch.
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
  });

  it('is never asked about a pair where only one branch changed anything', async () => {
    const pair = await checkedPair(rename.base, rename.a, NO_CHANGE);
    expect(pair.diagnostics).toEqual([]);
  });

  it('loads the compiler again after a load that failed', async () => {
    const pair = await fixtures.pair(rename.base, rename.a, rename.b);
    const request = {
      runId: ulid<SpeculativeRunId>(),
      branchA: pair.branchA,
      branchB: pair.branchB,
      changeSetA: pair.changeSetA,
      changeSetB: pair.changeSetB,
      merge: pair.merge,
      mergedTreeOid: pair.merged.treeOid,
      diagnostics: [],
      now: new Date().toISOString(),
    };
    vi.resetModules();
    vi.doMock('typescript', () => {
      throw new Error('no compiler');
    });
    try {
      const fresh = await import('../src/analyzers/attribution.js');
      await expect(
        fresh.attributeDiagnostics(request, { runner: createGitRunner() }),
      ).rejects.toThrow();
      vi.doUnmock('typescript');
      await expect(
        fresh.attributeDiagnostics(request, { runner: createGitRunner() }),
      ).resolves.toEqual({ findings: [], dropped: 0 });
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});

describe('every claim a ChangeSet makes is checked against the trees', () => {
  it('and one that does not hold names no branch', async () => {
    const pair = await checkedPair(rename.base, rename.a, rename.b);
    const fileOf = (path: string) =>
      pair.changeSetA.files.find((file) => file.path === path || file.previousPath === path)!;
    const payments = fileOf('src/payments.ts');
    const forged: Partial<Parameters<Pair['attribute']>[0]>[] = [
      // Deleted, though the merged commit still has it.
      {
        changeSetA: {
          ...pair.changeSetA,
          files: pair.changeSetA.files.map((file) =>
            file === payments ? { ...file, kind: 'deleted' as const } : file,
          ),
        },
      },
      // Renamed to a path the merged commit does not have.
      {
        changeSetA: {
          ...pair.changeSetA,
          files: pair.changeSetA.files.map((file) =>
            file === payments
              ? { ...file, kind: 'renamed' as const, path: 'src/gone.ts', previousPath: file.path }
              : file,
          ),
        },
      },
      // Modified, with a hunk, where the blob is the base's.
      {
        changeSetB: {
          ...pair.changeSetB,
          files: [
            ...pair.changeSetB.files,
            { ...payments, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] },
          ],
        },
      },
      // Modified, where its base never had the file.
      {
        changeSetB: {
          ...pair.changeSetB,
          files: pair.changeSetB.files.map((file) => ({ ...file, kind: 'modified' as const })),
        },
      },
      // Renamed from a path its base never had.
      {
        changeSetB: {
          ...pair.changeSetB,
          files: pair.changeSetB.files.map((file) => ({
            ...file,
            kind: 'renamed' as const,
            previousPath: 'src/nowhere.ts',
          })),
        },
      },
      // A base in which the declaration it compares hunks with is not there.
      { changeSetA: { ...pair.changeSetA, mergeBaseSha: pair.merge.commitA } },
    ];
    for (const overrides of forged) {
      expectUnattributed(only((await pair.attribute(overrides)).findings), 'stale-change-set');
    }
  });

  it('a declaration whose file the declaring branch deleted is a removal, spanned where it was', async () => {
    const pair = await fixtures.pair(
      rename.base,
      {
        committed: [
          { op: 'delete', path: 'src/payments.ts' },
          { op: 'delete', path: 'src/checkout.ts' },
        ],
        uncommitted: [],
      },
      committed(write('src/support.ts', SUPPORT)),
    );
    // The compiler says the module is missing (2307); asked as a stale import
    // instead, so the one path where the declaring side has no copy is taken.
    const diagnostic: FileDiagnostic = {
      code: 2305,
      category: 'error',
      message: "Module '\"./payments\"' has no exported member 'processRefund'.",
      file: 'src/support.ts',
      start: 9,
      length: 13,
      line: 1,
      column: 10,
    };
    const finding = only((await pair.attribute({ diagnostics: [diagnostic] })).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.generic);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/payments.ts', startLine: 1, endLine: 0 },
    ]);
  });
});

describe('more of what a branch can hold', () => {
  /** Past the parse cap: a file attribution reads as unreadable. */
  const huge = `// ${'x'.repeat(MAX_PARSED_BYTES)}\n`;
  const ledger = lines(
    'export class Ledger {',
    '  processRefund(orderId: string): string {',
    '    return orderId;',
    '  }',
    '',
    '  charge(cents: number): string {',
    '    return String(cents);',
    '  }',
    '}',
  );

  it('names the second branch when it is the one that changed the declaration', async () => {
    const pair = await checkedPair(rename.base, rename.b, rename.a);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.rename);
    expect(finding.attribution.originBranch).toBe(pair.branchB);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/payments.ts', startLine: 1, endLine: 1 },
    ]);
  });

  it("attributes a method's changed signature from a call through its object", async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/ledger.ts': ledger, 'src/huge.ts': huge },
      committed(
        write(
          'src/ledger.ts',
          ledger
            .replace('charge(cents: number)', 'charge(cents: number, currency: string)')
            .replace('String(cents)', '`${currency}${String(cents)}`'),
        ),
        // An unreadable file among those either branch changed is passed over.
        write('src/huge.ts', `${huge}// touched\n`),
      ),
      committed(
        write(
          'src/support.ts',
          lines(
            'import { Ledger } from "./ledger";',
            '',
            'export const bill = (ledger: Ledger): string =>',
            '  ledger.charge(5);',
          ),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2554]);
    const finding = only((await pair.attribute()).findings);
    expect(finding.rule).toBe(ATTRIBUTION_RULES.signature);
    expect(finding.attribution.originBranch).toBe(pair.branchA);
    expect(spans(finding, pair.branchA)).toEqual([
      { path: 'src/ledger.ts', startLine: 6, endLine: 6 },
    ]);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
    ]);
  });

  it('finds the move past a changed file it cannot read', async () => {
    const moved = SEMANTIC_CASES.find((each) => each.id === 'moved-export-vs-import')!;
    const pair = await checkedPair(
      moved.base,
      committed(...moved.a.committed, write('src/huge.ts', huge)),
      moved.b,
    );
    expect(only((await pair.attribute()).findings).rule).toBe(ATTRIBUTION_RULES.movedExport);
  });

  it('spans every use of a stale import, and nothing that only shares its name', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import { processRefund } from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
            'export type Refund = typeof processRefund.name;',
            'export const handlers = { processRefund };',
            'export const flags = { processRefund: true };',
            'export const enabled = flags.processRefund;',
            'export type Flag = typeof flags.processRefund;',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    // Through the shorthand on line 7, adjacent uses one span; not the property
    // and the member after it.
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 1 },
      { path: 'src/support.ts', startLine: 4, endLine: 4 },
      { path: 'src/support.ts', startLine: 6, endLine: 7 },
    ]);
  });

  it("spans a line of uses once, and none on the import's own line", async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'import { processRefund } from "./payments"; export const now = processRefund("n");',
            'export const both = processRefund("a") + processRefund("b");',
          ),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 1 },
      { path: 'src/support.ts', startLine: 2, endLine: 2 },
    ]);
  });

  it('spans a use far from its import alone, and no more uses than the bound', async () => {
    const filler = Array.from({ length: 300 }, (_, index) => `// ${String(index)}`);
    const uses = Array.from({ length: MAX_SPANS_PER_SIDE + 2 }, (_, index) => [
      '',
      `export const r${String(index)} = processRefund('${String(index)}');`,
    ]).flat();
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines('import { processRefund } from "./payments";', ...filler, ...uses),
        ),
      ),
    );
    const finding = only((await pair.attribute()).findings);
    // The import, then the first uses in line order: each after a blank line,
    // from line 303, and none of the filler between.
    expect(spans(finding, pair.branchB)).toEqual([
      { path: 'src/support.ts', startLine: 1, endLine: 1 },
      ...Array.from({ length: MAX_SPANS_PER_SIDE - 1 }, (_, index) => ({
        path: 'src/support.ts',
        startLine: 303 + 2 * index,
        endLine: 303 + 2 * index,
      })),
    ]);
  });
});

describe('when a file it needs cannot be read, it names no branch', () => {
  const filler = Array.from(
    { length: 3000 },
    (_, index) => `// ${String(index).padStart(96, '.')}`,
  ).join('\n');
  const settle = lines(
    'export function settleBatch(batchId: string): string {',
    '  return batchId;',
    '}',
  );

  it("— the declaring module's, past the parse cap", async () => {
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': `${PAYMENTS}${filler}\n` },
      committed(
        write(
          'src/payments.ts',
          `${PAYMENTS.replace('processRefund', 'refundPayment')}${filler}\n`,
        ),
      ),
      committed(write('src/support.ts', SUPPORT)),
    );
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it("— one branch's own copy of the file, though the merged one reads", async () => {
    // `a` cuts the filler and renames; `b` calls the old name below it. Merged,
    // the file is small; `b`'s own copy, filler and all, is past the cap.
    const pair = await checkedPair(
      { ...PROJECT, 'src/payments.ts': `${PAYMENTS}${filler}\n${settle}` },
      committed(
        write('src/payments.ts', `${PAYMENTS.replace('processRefund', 'refundPayment')}${settle}`),
      ),
      committed(
        write(
          'src/payments.ts',
          `${PAYMENTS}${filler}\n${settle}${lines('', 'export const escalate = (id: string): string => processRefund(id);')}`,
        ),
      ),
    );
    expect(pair.diagnostics).toHaveLength(1);
    // The merge base's copy is past the cap too, which is the first thing
    // that cannot be told.
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });

  it('— a name that resolves nowhere in a file the merge base never had', async () => {
    const pair = await checkedPair(
      rename.base,
      rename.a,
      committed(
        write(
          'src/support.ts',
          lines(
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
          ),
        ),
      ),
    );
    expect(pair.diagnostics.map((each) => each.code)).toEqual([2304]);
    expectUnattributed(only((await pair.attribute()).findings), 'declaration-not-found');
  });
});
