import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makePairKey, ulid } from '@interlock/shared';
import type {
  BranchRef,
  BranchRefId,
  ChangeSet,
  RepoId,
  SnapshotId,
  SpeculativeRunId,
} from '@interlock/shared';
import { attributeDiagnostics } from '../../src/analyzers/attribution.js';
import type { AttributedDiagnostics, AttributionRequest } from '../../src/analyzers/attribution.js';
import { listTree } from '../../src/analyzers/typecheck.js';
import type { FileDiagnostic, TypecheckRegistry } from '../../src/analyzers/typecheck.js';
import { extractChangeSet } from '../../src/git/diff.js';
import { createGitRunner } from '../../src/git/repo-handle.js';
import type { ShadowRepo, UserRepo } from '../../src/git/repo-handle.js';
import { ensureShadow } from '../../src/git/shadow.js';
import { createWorktreePool } from '../../src/git/worktree-pool.js';
import { captureDirtyState, commitSnapshotInShadow } from '../../src/git/worktree.js';
import { speculativeMerge } from '../../src/merge/speculative-merge.js';
import type {
  SpeculativeMergeRequest,
  SpeculativeMergeResult,
} from '../../src/merge/speculative-merge.js';

/**
 * Pairs to attribute, built the way the daemon holds them: a user repository
 * in a temporary directory, each branch in a worktree of its own, uncommitted
 * work captured into the shadow as a snapshot commit, the pair merged in the
 * shadow and each side's ChangeSet extracted as the watcher extracts it. The
 * diagnostics come from the type-check service run on the merged slot.
 */

export type Files = Readonly<Record<string, string>>;

/** One change to a branch, as the evaluation suite's fixtures write them. */
export type Operation =
  | { readonly op: 'write'; readonly path: string; readonly content: string }
  | { readonly op: 'delete'; readonly path: string }
  | { readonly op: 'rename'; readonly from: string; readonly to: string };

export interface BranchSpec {
  readonly committed: readonly Operation[];
  readonly uncommitted: readonly Operation[];
}

/** A labelled span, 1-based and inclusive, on one branch's own copy of a file. */
export interface LabelSpan {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** What the evaluation suite expects of a fixture, in its own terms. */
export interface Label {
  readonly analyzer: 'typecheck' | 'test';
  readonly class: string;
  readonly path: string;
  readonly symbol: string;
  readonly spanA: LabelSpan | null;
  readonly spanB: LabelSpan | null;
}

export interface SemanticCase {
  readonly id: string;
  readonly base: Files;
  readonly a: BranchSpec;
  readonly b: BranchSpec;
  readonly expected: readonly Label[];
  readonly twinOf: string | null;
}

export interface Pair {
  readonly user: string;
  readonly branchA: BranchRefId;
  readonly branchB: BranchRefId;
  readonly merge: SpeculativeMergeRequest;
  readonly merged: SpeculativeMergeResult;
  readonly changeSetA: ChangeSet;
  readonly changeSetB: ChangeSet;
  /** What the type-check service reports for the merged tree; empty unless asked for. */
  readonly diagnostics: readonly FileDiagnostic[];
  /** Attribute the pair's diagnostics, or what `overrides` puts in their place. */
  attribute(overrides?: Partial<AttributionRequest>): Promise<AttributedDiagnostics>;
}

export interface PairOptions {
  /** Check the merged tree with this registry and keep what it reports. */
  readonly registry?: TypecheckRegistry;
  /** The base's commit is the merge base unless a branch should fork later. */
  readonly forkB?: BranchSpec;
}

export interface AttributionFixtures {
  pair(base: Files, a: BranchSpec, b: BranchSpec, options?: PairOptions): Promise<Pair>;
  dispose(): void;
}

/** A branch with nothing on it beyond the base. */
export const NO_CHANGE: BranchSpec = { committed: [], uncommitted: [] };

export function attributionFixtures(): AttributionFixtures {
  const roots: string[] = [];
  return {
    async pair(base, a, b, options = {}) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-attribution-')));
      roots.push(root);
      return buildPair(root, base, a, b, options);
    },
    dispose() {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    },
  };
}

async function buildPair(
  root: string,
  base: Files,
  a: BranchSpec,
  b: BranchSpec,
  options: PairOptions,
): Promise<Pair> {
  const user = join(root, 'user');
  const dataDir = join(root, 'data');
  const runner = createGitRunner();
  const repoId = ulid<RepoId>();
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', user], { stdio: 'pipe' });
  git(user, 'config', 'user.name', 'Interlock Test');
  git(user, 'config', 'user.email', 'test@example.invalid');
  // Since git 2.47 `commit` detaches a maintenance process that holds
  // `objects/maintenance.lock` after the commit returns.
  git(user, 'config', 'maintenance.auto', 'false');
  git(user, 'config', 'gc.auto', '0');
  apply(
    user,
    Object.entries(base).map(([path, content]) => ({ op: 'write', path, content })),
  );
  git(user, 'add', '-A');
  git(user, 'commit', '-qm', 'base');
  let forkPoint = git(user, 'rev-parse', 'HEAD');
  const mergeBaseSha = forkPoint;
  if (options.forkB !== undefined) {
    // The default branch moves on after `a` forks, and `b` forks from there:
    // `b`'s ChangeSet is against a base the pair does not share.
    apply(user, options.forkB.committed);
    git(user, 'add', '-A');
    git(user, 'commit', '-qm', 'default moves on');
    forkPoint = git(user, 'rev-parse', 'HEAD');
  }
  const handle: UserRepo = { kind: 'user', rootPath: user, gitDir: join(user, '.git') };

  const now = new Date().toISOString();
  const branches: { name: string; spec: BranchSpec; from: string; worktree: string }[] = [
    { name: 'a', spec: a, from: mergeBaseSha, worktree: join(root, 'wt-a') },
    { name: 'b', spec: b, from: forkPoint, worktree: join(root, 'wt-b') },
  ];
  const heads: string[] = [];
  for (const branch of branches) {
    git(user, 'worktree', 'add', '-q', '-b', branch.name, branch.worktree, branch.from);
    apply(branch.worktree, branch.spec.committed);
    git(branch.worktree, 'add', '-A');
    git(branch.worktree, 'commit', '-q', '--allow-empty', '-m', branch.name);
    heads.push(git(branch.worktree, 'rev-parse', 'HEAD'));
    apply(branch.worktree, branch.spec.uncommitted);
  }

  const shadow: ShadowRepo = await ensureShadow(handle, { runner, dataDir, repoId });
  const sides: { id: BranchRefId; commit: string; changeSet: ChangeSet }[] = [];
  for (const [index, branch] of branches.entries()) {
    const headSha = heads[index]!;
    const ref: BranchRef = {
      id: ulid<BranchRefId>(),
      repoId,
      ref: `refs/heads/${branch.name}`,
      name: branch.name,
      headSha,
      worktreePath: branch.worktree,
      dirty: null,
      sessionId: null,
      firstSeenAt: now,
      updatedAt: now,
    };
    if (branch.spec.uncommitted.length === 0) {
      const changeSet = await extractChangeSet(handle, ref, branch.from, { runner });
      sides.push({ id: ref.id, commit: headSha, changeSet });
      continue;
    }
    const snapshot = await captureDirtyState(branch.worktree, handle, {
      runner,
      objectStore: shadow,
    });
    const { commitSha } = await commitSnapshotInShadow(shadow, snapshot, { runner });
    const changeSet = await extractChangeSet(handle, ref, branch.from, {
      runner,
      snapshot: { id: ulid<SnapshotId>(), treeOid: snapshot.treeOid },
      objectStore: shadow,
    });
    sides.push({ id: ref.id, commit: commitSha, changeSet });
  }
  const [sideA, sideB] = sides as [(typeof sides)[0], (typeof sides)[0]];

  const merge: SpeculativeMergeRequest = {
    shadow,
    commitA: sideA.commit,
    commitB: sideB.commit,
    mergeBaseSha,
  };
  const merged = await speculativeMerge(merge, { runner });
  if (!merged.clean) throw new Error('an attribution fixture merged with a conflict');

  let diagnostics: readonly FileDiagnostic[] = [];
  if (options.registry !== undefined) {
    const registry = options.registry;
    const pool = createWorktreePool(shadow, { runner, dataDir, repoId, size: 1 });
    const outcome = await pool.withSlot(
      {
        key: makePairKey(sideA.id, sideB.id),
        commitA: sideA.commit,
        commitB: sideB.commit,
        merged,
        // The fixtures install nothing, so the base's tree stands for the
        // dependency checkout's.
        dependencyTreeOid: git(user, 'rev-parse', `${mergeBaseSha}^{tree}`),
      },
      async (slot) => {
        try {
          return await registry.check({
            root: slot.path,
            dependencyRoot: user,
            tree: await listTree(runner, slot.repo, slot.treeOid),
          });
        } finally {
          await registry.release(slot.path);
        }
      },
    );
    if (outcome.kind !== 'ran') throw new Error(`the slot was skipped: ${outcome.reason}`);
    if (outcome.value.kind !== 'checked') {
      throw new Error(`the check did not complete: ${outcome.value.kind}`);
    }
    diagnostics = outcome.value.report.files;
  }

  const request: AttributionRequest = {
    runId: ulid<SpeculativeRunId>(),
    branchA: sideA.id,
    branchB: sideB.id,
    changeSetA: sideA.changeSet,
    changeSetB: sideB.changeSet,
    merge,
    mergedTreeOid: merged.treeOid,
    diagnostics,
    now,
  };
  return {
    user,
    branchA: sideA.id,
    branchB: sideB.id,
    merge,
    merged,
    changeSetA: sideA.changeSet,
    changeSetB: sideB.changeSet,
    diagnostics,
    attribute: (overrides = {}) => attributeDiagnostics({ ...request, ...overrides }, { runner }),
  };
}

function apply(where: string, operations: readonly Operation[]): void {
  for (const operation of operations) {
    if (operation.op === 'write') {
      mkdirSync(dirname(join(where, operation.path)), { recursive: true });
      writeFileSync(join(where, operation.path), operation.content);
    } else if (operation.op === 'delete') {
      rmSync(join(where, operation.path));
    } else {
      mkdirSync(dirname(join(where, operation.to)), { recursive: true });
      execFileSync('git', ['-C', where, 'mv', operation.from, operation.to], { stdio: 'pipe' });
    }
  }
}

// --- The evaluation suite's semantic cases, mirrored ---------------------------------
//
// `eval/fixtures/semantic.ts` is read-only, and nothing under `packages/`
// imports from `eval/` (its own suite asserts it), so these are its typecheck
// cases and their twins, copied verbatim. A change there is copied here by hand.

export const PROJECT: Files = {
  'package.json': '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  'tsconfig.json': [
    '{',
    '  "compilerOptions": {',
    '    "strict": true,',
    '    "noEmit": true,',
    '    "target": "es2022",',
    '    "module": "esnext",',
    '    "moduleResolution": "bundler"',
    '  },',
    '  "include": ["src"]',
    '}',
    '',
  ].join('\n'),
};

export const lines = (...content: string[]): string => `${content.join('\n')}\n`;

export const PAYMENTS = lines(
  'export function processRefund(orderId: string): string {',
  '  return `refund:${orderId}`;',
  '}',
);
export const CHECKOUT = lines(
  'import { processRefund } from "./payments";',
  '',
  'export function cancel(orderId: string): string {',
  '  return processRefund(orderId);',
  '}',
);
const renamed = [
  {
    op: 'write',
    path: 'src/payments.ts',
    content: PAYMENTS.replace('processRefund', 'refundPayment'),
  },
  {
    op: 'write',
    path: 'src/checkout.ts',
    content: CHECKOUT.replaceAll('processRefund', 'refundPayment'),
  },
] as const;

const format = lines(
  'export function formatPrice(amount: number): string {',
  '  return amount.toFixed(2);',
  '}',
);
const cart = lines(
  'import { formatPrice } from "./format";',
  '',
  'export function label(total: number): string {',
  '  return formatPrice(total);',
  '}',
);
const invoice = lines(
  'import { formatPrice } from "./format";',
  '',
  'export function line(amount: number): string {',
  '  return `total ${formatPrice(amount)}`;',
  '}',
);

const utils = lines(
  'export function slugify(text: string): string {',
  '  return text.toLowerCase().replace(/\\s+/g, "-");',
  '}',
  '',
  'export function truncate(text: string, length: number): string {',
  '  return text.slice(0, length);',
  '}',
);
const truncateOnly = lines(
  'export function truncate(text: string, length: number): string {',
  '  return text.slice(0, length);',
  '}',
);
const strings = lines(
  'export function slugify(text: string): string {',
  '  return text.toLowerCase().replace(/\\s+/g, "-");',
  '}',
);
const post = lines(
  'import { slugify } from "./utils";',
  '',
  'export function permalink(title: string): string {',
  '  return `/posts/${slugify(title)}`;',
  '}',
);
const tag = lines(
  'import { slugify } from "./utils";',
  '',
  'export function tagUrl(name: string): string {',
  '  return `/tags/${slugify(name)}`;',
  '}',
);

export const SEMANTIC_CASES: readonly SemanticCase[] = [
  {
    id: 'rename-vs-callsite',
    base: { ...PROJECT, 'src/payments.ts': PAYMENTS, 'src/checkout.ts': CHECKOUT },
    a: { committed: renamed, uncommitted: [] },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/support.ts',
          content: lines(
            'import { processRefund } from "./payments";',
            '',
            'export function escalate(orderId: string): string {',
            '  return processRefund(orderId);',
            '}',
          ),
        },
      ],
    },
    expected: [
      {
        analyzer: 'typecheck',
        class: 'rename-vs-callsite',
        path: 'src/support.ts',
        symbol: 'processRefund',
        spanA: { path: 'src/payments.ts', start: 1, end: 1 },
        spanB: { path: 'src/support.ts', start: 1, end: 4 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'rename-vs-callsite-twin-no-new-call',
    base: { ...PROJECT, 'src/payments.ts': PAYMENTS, 'src/checkout.ts': CHECKOUT },
    a: { committed: renamed, uncommitted: [] },
    b: {
      committed: [],
      uncommitted: [
        {
          op: 'write',
          path: 'src/support.ts',
          content: lines(
            'export function escalate(orderId: string): string {',
            '  return `escalate:${orderId}`;',
            '}',
          ),
        },
      ],
    },
    expected: [],
    twinOf: 'rename-vs-callsite',
  },
  {
    id: 'signature-vs-caller',
    base: { ...PROJECT, 'src/format.ts': format, 'src/cart.ts': cart },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/format.ts',
          content: lines(
            'export function formatPrice(amount: number, currency: string): string {',
            '  return `${currency} ${amount.toFixed(2)}`;',
            '}',
          ),
        },
        {
          op: 'write',
          path: 'src/cart.ts',
          content: cart.replace('formatPrice(total)', 'formatPrice(total, "EUR")'),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [{ op: 'write', path: 'src/invoice.ts', content: invoice }], uncommitted: [] },
    expected: [
      {
        analyzer: 'typecheck',
        class: 'signature-vs-caller',
        path: 'src/invoice.ts',
        symbol: 'formatPrice',
        spanA: { path: 'src/format.ts', start: 1, end: 1 },
        spanB: { path: 'src/invoice.ts', start: 4, end: 4 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'signature-vs-caller-twin-optional-parameter',
    base: { ...PROJECT, 'src/format.ts': format, 'src/cart.ts': cart },
    a: {
      committed: [
        {
          op: 'write',
          path: 'src/format.ts',
          content: lines(
            'export function formatPrice(amount: number, currency = "USD"): string {',
            '  return `${currency} ${amount.toFixed(2)}`;',
            '}',
          ),
        },
      ],
      uncommitted: [],
    },
    b: { committed: [{ op: 'write', path: 'src/invoice.ts', content: invoice }], uncommitted: [] },
    expected: [],
    twinOf: 'signature-vs-caller',
  },
  {
    id: 'moved-export-vs-import',
    base: { ...PROJECT, 'src/utils.ts': utils, 'src/post.ts': post },
    a: {
      committed: [
        { op: 'write', path: 'src/strings.ts', content: strings },
        { op: 'write', path: 'src/utils.ts', content: truncateOnly },
        { op: 'write', path: 'src/post.ts', content: post.replace('"./utils"', '"./strings"') },
      ],
      uncommitted: [],
    },
    b: { committed: [], uncommitted: [{ op: 'write', path: 'src/tag.ts', content: tag }] },
    expected: [
      {
        analyzer: 'typecheck',
        class: 'moved-export-vs-import',
        path: 'src/tag.ts',
        symbol: 'slugify',
        spanA: { path: 'src/strings.ts', start: 1, end: 3 },
        spanB: { path: 'src/tag.ts', start: 1, end: 4 },
      },
    ],
    twinOf: null,
  },
  {
    id: 'moved-export-vs-import-twin-re-exported',
    base: { ...PROJECT, 'src/utils.ts': utils, 'src/post.ts': post },
    a: {
      committed: [
        { op: 'write', path: 'src/strings.ts', content: strings },
        {
          op: 'write',
          path: 'src/utils.ts',
          content: `export { slugify } from "./strings";\n\n${truncateOnly}`,
        },
      ],
      uncommitted: [],
    },
    b: { committed: [], uncommitted: [{ op: 'write', path: 'src/tag.ts', content: tag }] },
    expected: [],
    twinOf: 'moved-export-vs-import',
  },
];
