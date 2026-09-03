import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '@interlock/core';
import { createLogger, makePairKey, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  ChangeSet,
  ChangeSetId,
  InterlockEvent,
  LogRecord,
  MergePair,
  MergePairId,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus/index.js';
import { openStore } from '../src/store/index.js';
import type { Store } from '../src/store/index.js';
import { rejection } from './support/rejection.js';
import { createSweep } from '../src/watcher/sweep.js';
import type { Sweep } from '../src/watcher/sweep.js';

/**
 * The sweep against real repositories and a real store, because everything it
 * decides — is this branch new, is it gone, whose config applies — is a
 * comparison between what git reports and what was written down.
 */

describe('reconciliation sweep', () => {
  let base: string;
  let root: string;
  let store: Store;
  let bus: EventBus;
  let sweep: Sweep;
  let events: InterlockEvent[];
  let logs: LogRecord[];

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const init = (path: string): void => {
    execFileSync('git', ['init', '-q', '-b', 'main', path], { stdio: 'pipe' });
    git(path, 'config', 'user.name', 'Interlock Test');
    git(path, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(path, 'a.txt'), 'a\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', 'one');
  };

  const of = <T extends InterlockEvent['type']>(type: T): InterlockEvent[] =>
    events.filter((event) => event.type === type);

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-sweep-')));
    root = join(base, 'repo');
    init(root);

    events = [];
    logs = [];
    bus = new EventBus({ logger: createLogger('test', { level: 'error', sink: () => undefined }) });
    bus.onAny((event) => {
      events.push(event);
    });
    store = await openStore({ path: ':memory:' });
    sweep = createSweep({
      store,
      bus,
      runner: createGitRunner(),
      dataDir: join(base, 'data'),
      logger: createLogger('test', { level: 'trace', sink: (record) => logs.push(record) }),
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('records a repository and its branches on first sighting', async () => {
    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    expect(repo?.rootPath).toBe(root);
    expect(of('repo.discovered')).toHaveLength(1);

    const branches = await store.listBranchRefs(repo!.id);
    expect(branches.map((branch) => branch.name)).toEqual(['main']);
    expect(of('branch.appeared')).toHaveLength(1);
  });

  it('says nothing new about a repository that has not changed', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    await sweep.reconcile(root);

    // A sweep runs on a timer; one that republished everything it saw would
    // make the event log grow with the clock rather than with the work.
    expect(events).toEqual([]);
    expect(await store.listRepos()).toHaveLength(1);
  });

  it('reports a branch created between sweeps', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    git(root, 'branch', 'feature');
    await sweep.reconcile(root);

    expect(of('branch.appeared')).toHaveLength(1);
    const [repo] = await store.listRepos();
    expect((await store.listBranchRefs(repo!.id)).map((branch) => branch.name).sort()).toEqual([
      'feature',
      'main',
    ]);
  });

  it('reports a commit as a branch update', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    writeFileSync(join(root, 'b.txt'), 'b\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'two');
    await sweep.reconcile(root);

    const updated = of('branch.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ headSha: git(root, 'rev-parse', 'HEAD').trim() });
  });

  it('reports a worktree becoming dirty', async () => {
    await sweep.reconcile(root);
    events.length = 0;

    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await sweep.reconcile(root);

    expect(of('branch.updated')).toMatchObject([{ dirty: true }]);
  });

  it('deletes a branch that is gone, and its pairs and change sets with it', async () => {
    await sweep.reconcile(root);
    git(root, 'branch', 'feature');
    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    const branches = await store.listBranchRefs(repo!.id);
    const feature = branches.find((branch) => branch.name === 'feature')!;
    const main = branches.find((branch) => branch.name === 'main')!;

    const pair: MergePair = {
      id: ulid<MergePairId>(),
      repoId: repo!.id,
      a: main.id,
      b: feature.id,
      key: makePairKey(main.id, feature.id),
      mergeBaseSha: 'd'.repeat(40),
      priority: 1,
      lastRunAt: null,
      stale: false,
    };
    const changeSet: ChangeSet = {
      id: ulid<ChangeSetId>(),
      branchRefId: feature.id,
      snapshotId: null,
      mergeBaseSha: 'd'.repeat(40),
      headSha: feature.headSha,
      files: [],
      computedAt: new Date().toISOString(),
    };
    await store.upsertMergePair(pair);
    await store.upsertChangeSet(changeSet);
    events.length = 0;

    git(root, 'branch', '-D', 'feature');
    await sweep.reconcile(root);

    expect(of('branch.disappeared')).toMatchObject([{ reason: 'deleted' }]);
    expect((await store.listBranchRefs(repo!.id)).map((branch) => branch.name)).toEqual(['main']);
    // Without the cascade these outlive the branch for good: `prune` keeps each
    // branch's newest change set, so retention never reaches them either.
    expect(await store.listMergePairs(repo!.id)).toEqual([]);
    expect(await store.getChangeSet(changeSet.id)).toBeNull();
  });

  it('honours ignoreBranches from the repository’s own file', async () => {
    writeFileSync(join(root, '.interlock.json'), JSON.stringify({ ignoreBranches: ['release/*'] }));
    git(root, 'branch', 'release/1.0');
    git(root, 'branch', 'feature');

    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    expect((await store.listBranchRefs(repo!.id)).map((branch) => branch.name).sort()).toEqual([
      'feature',
      'main',
    ]);
  });

  it('honours a branch added to ignoreBranches mid-session', async () => {
    git(root, 'branch', 'release/1.0');
    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    expect(await store.listBranchRefs(repo!.id)).toHaveLength(2);

    writeFileSync(join(root, '.interlock.json'), JSON.stringify({ ignoreBranches: ['release/*'] }));
    await sweep.reconcile(root);

    // Read once at first sighting, the stored config would be the last word and
    // a repository asking to be left alone would be watched until a restart.
    expect((await store.listBranchRefs(repo!.id)).map((branch) => branch.name)).toEqual(['main']);
    // Still a branch in git — reported as deleted, a replay would read the
    // repository's own exclusion as a destruction.
    expect(of('branch.disappeared')).toMatchObject([{ reason: 'ignored' }]);
  });

  it('keeps the last good config when the override file becomes malformed', async () => {
    writeFileSync(join(root, '.interlock.json'), JSON.stringify({ ignoreBranches: ['release/*'] }));
    git(root, 'branch', 'release/1.0');
    await sweep.reconcile(root);

    writeFileSync(join(root, '.interlock.json'), '{ not json');
    await expect(sweep.reconcile(root)).resolves.toBeUndefined();

    const [repo] = await store.listRepos();
    expect(repo?.config).toEqual({ ignoreBranches: ['release/*'] });
    // Still applied, so the repository does not silently start being watched
    // where it asked not to be.
    expect((await store.listBranchRefs(repo!.id)).map((branch) => branch.name)).toEqual(['main']);
    expect(logs.map((record) => record.msg)).toContain(
      'the repository override file is invalid; keeping the last good config',
    );
  });

  it('refuses a first sighting whose override file is malformed', async () => {
    writeFileSync(join(root, '.interlock.json'), '{ not json');

    // The code matters, not just that something threw: keeping a `stored` that
    // does not exist yet produces a repo with no id, and the constraint
    // violation that follows rejects too — for a reason nobody could act on.
    const error = await rejection(sweep.reconcile(root));
    expect(error.code).toBe('CONFIG_INVALID');

    // Nothing was ever good here, so there is no last-good config to keep and
    // storing the defaults would watch what the file may have excluded.
    expect(await store.listRepos()).toEqual([]);
  });

  it('reports a disappearance before the row it describes is gone', async () => {
    await sweep.reconcile(root);
    git(root, 'branch', 'feature');
    await sweep.reconcile(root);
    const [repo] = await store.listRepos();

    const seenWhilePublished: number[] = [];
    bus.on('branch.disappeared', async () => {
      // The branch is still stored at this point, so a failure here leaves it
      // to be reported again rather than losing the event for good.
      seenWhilePublished.push((await store.listBranchRefs(repo!.id)).length);
    });

    git(root, 'branch', '-D', 'feature');
    await sweep.reconcile(root);

    expect(seenWhilePublished).toEqual([2]);
    expect(await store.listBranchRefs(repo!.id)).toHaveLength(1);
  });

  it('recognises a repository registered by a subdirectory', async () => {
    const nested = join(root, 'src');
    mkdirSync(nested, { recursive: true });

    await sweep.reconcile(nested);
    await sweep.reconcile(nested);

    // `openUserRepo` resolves a subdirectory to the main worktree, which is what
    // gets stored. Looking the argument up instead finds nothing every pass, so
    // the repository is announced as new for as long as the daemon runs.
    expect(of('repo.discovered')).toHaveLength(1);
    expect(await store.listRepos()).toHaveLength(1);
  });

  it('recognises a repository registered by a symlink', async () => {
    const link = join(base, 'link-to-repo');
    symlinkSync(root, link);

    await sweep.reconcile(link);
    await sweep.reconcile(link);

    expect(of('repo.discovered')).toHaveLength(1);
    expect((await store.listRepos()).map((repo) => repo.rootPath)).toEqual([root]);
  });

  it('keeps the last good config for a repository registered by a subdirectory', async () => {
    const nested = join(root, 'src');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.interlock.json'), JSON.stringify({ ignoreBranches: ['release/*'] }));
    await sweep.reconcile(nested);

    writeFileSync(join(root, '.interlock.json'), '{ not json');
    await expect(sweep.reconcile(nested)).resolves.toBeUndefined();

    // The fallback needs a stored row to fall back to, so a lookup that never
    // finds one degrades this from "warn and keep working" to "fail every pass".
    expect((await store.listRepos())[0]?.config).toEqual({ ignoreBranches: ['release/*'] });
  });

  it('reports a branch again once it is removed from ignoreBranches', async () => {
    writeFileSync(join(root, '.interlock.json'), JSON.stringify({ ignoreBranches: ['release/*'] }));
    git(root, 'branch', 'release/1.0');
    await sweep.reconcile(root);
    events.length = 0;

    writeFileSync(join(root, '.interlock.json'), JSON.stringify({ ignoreBranches: [] }));
    await sweep.reconcile(root);

    // The row was deleted when it began being ignored, so coming back is an
    // appearance rather than an update.
    expect(of('branch.appeared')).toHaveLength(1);
    const [repo] = await store.listRepos();
    expect((await store.listBranchRefs(repo!.id)).map((branch) => branch.name).sort()).toEqual([
      'main',
      'release/1.0',
    ]);
  });

  it('joins a pass already running for the same repository', async () => {
    // Asserted on identity rather than on the events: whether concurrent passes
    // actually interleave depends on how far apart their git calls land, so a
    // count can be right by luck on a build where the guard is gone.
    const first = sweep.reconcile(root);
    const second = sweep.reconcile(root);

    expect(second).toBe(first);
    await first;
  });

  it('runs a repository again once its pass has finished', async () => {
    await sweep.reconcile(root);
    const later = sweep.reconcile(root);

    // Joined only while in flight; an entry left behind would make every later
    // sweep return the first pass's result and the repository would freeze.
    expect(later).not.toBe(Promise.resolve());
    await later;
    expect(await store.listRepos()).toHaveLength(1);
  });

  it('announces a branch once when both triggers fire together', async () => {
    await sweep.reconcile(root);
    events.length = 0;
    git(root, 'branch', 'feature');

    // Every git call slowed, so the passes genuinely overlap rather than
    // finishing one after another by accident of timing.
    const slow = createSweep({
      store,
      bus,
      runner: {
        run: async (repo, args, runOptions) => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return createGitRunner().run(repo, args, runOptions);
        },
      },
      dataDir: join(base, 'data'),
    });

    await Promise.all([slow.reconcile(root), slow.reconcile(root), slow.reconcile(root)]);

    // Both passes would otherwise read the stored branches before either wrote,
    // see the branch as new, and announce it twice into an append-only log.
    expect(of('branch.appeared')).toHaveLength(1);
  });

  it('reports a branch that moved to another worktree', async () => {
    git(root, 'branch', 'feature');
    await sweep.reconcile(root);
    events.length = 0;

    const linked = join(base, 'wt-feature');
    git(root, 'worktree', 'add', '-q', linked, 'feature');
    await sweep.reconcile(root);

    // The event cannot carry the new path, but a watcher holding a watch on the
    // old one has to learn to re-read.
    expect(of('branch.updated')).toHaveLength(1);
  });

  it('says nothing when only which files are dirty changed', async () => {
    writeFileSync(join(root, 'a.txt'), 'edited\n');
    await sweep.reconcile(root);
    events.length = 0;

    writeFileSync(join(root, 'b.txt'), 'another\n');
    await sweep.reconcile(root);

    // Still dirty, still the same head. Which files changed is the filesystem
    // watcher's own signal, and repeating it here carries nothing new.
    expect(of('branch.updated')).toEqual([]);
  });

  it('looks a repository up by its unique path rather than scanning the table', async () => {
    const other = join(base, 'other');
    init(other);
    await sweep.all([root, other]);

    // `all()` asks once per repository; a scan per ask is quadratic by
    // construction on the path task 3 has to measure.
    const looked = await store.getRepoByPath(root);
    expect(looked?.rootPath).toBe(root);
    expect(await store.getRepoByPath(join(base, 'never-seen'))).toBeNull();
  });

  it('publishes the transition from readable to unreadable as unknown', async () => {
    const linked = join(base, 'wt-feature');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    await sweep.reconcile(root);
    events.length = 0;

    // Locked, so git keeps listing it rather than treating it as prunable.
    git(root, 'worktree', 'lock', linked);
    rmSync(linked, { recursive: true, force: true });
    await sweep.reconcile(root);

    // Readable-and-clean to unreadable is a change, and it is the transition a
    // flag folding `null` into `false` cannot see at all: it reads both as
    // clean and publishes nothing.
    const updated = of('branch.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ dirty: null });
  });

  it('contains a failing repository to itself', async () => {
    const healthy = join(base, 'healthy');
    init(healthy);
    writeFileSync(join(root, '.interlock.json'), '{ not json');

    const outcome = await sweep.all([root, healthy, join(base, 'not-a-repo')]);

    expect(outcome.reconciled).toEqual([healthy]);
    expect(outcome.failed).toEqual([root, join(base, 'not-a-repo')]);
    // The healthy one is fully recorded despite being listed after the broken one.
    expect((await store.listRepos()).map((repo) => repo.rootPath)).toEqual([healthy]);
  });

  it('stores a first sighting of an unreadable worktree as unknown, not clean', async () => {
    const linked = join(base, 'wt-gone');
    git(root, 'worktree', 'add', '-q', '-b', 'gone', linked);
    git(root, 'worktree', 'lock', linked);
    rmSync(linked, { recursive: true, force: true });

    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    const branches = await store.listBranchRefs(repo!.id);
    const gone = branches.find((branch) => branch.name === 'gone');
    expect(gone?.dirty).toBeNull();
  });

  it('keeps the id and shadow path a repository was first stored with', async () => {
    await sweep.reconcile(root);
    const [first] = await store.listRepos();

    await sweep.reconcile(root);
    const [second] = await store.listRepos();

    // Every sighting mints a fresh ULID; the stored one has to win or the
    // branches written against it orphan.
    expect(second?.id).toBe(first?.id);
    expect(second?.shadowPath).toBe(first?.shadowPath);
  });

  it('reconciles branches under the id that won, not the one just minted', async () => {
    await sweep.reconcile(root);
    await sweep.reconcile(root);

    const [repo] = await store.listRepos();
    const branches = await store.listBranchRefs(repo!.id);
    expect(branches).toHaveLength(1);
    expect(branches[0]?.repoId).toBe(repo!.id);
  });

  it('gives every event the repository it belongs to', async () => {
    await sweep.reconcile(root);
    const [repo] = await store.listRepos();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.repoId).toBe(repo!.id);
  });

  it('carries a branch id that resolves in the store', async () => {
    await sweep.reconcile(root);
    const [repo] = await store.listRepos();
    const stored = await store.listBranchRefs(repo!.id);

    const appeared = of('branch.appeared')[0] as { branchRefId: BranchRefId } | undefined;
    // The whole reason identity is resolved here rather than in the watcher: an
    // id in an event has to name a row that exists.
    expect(stored.map((branch) => branch.id)).toContain(appeared?.branchRefId);
  });

  it('reports nothing for a repository with no commits yet', async () => {
    const empty = join(base, 'empty');
    execFileSync('git', ['init', '-q', '-b', 'main', empty], { stdio: 'pipe' });

    await expect(sweep.reconcile(empty)).resolves.toBeUndefined();

    const repo = (await store.listRepos()).find((each) => each.rootPath === empty);
    expect(repo).toBeDefined();
    expect(await store.listBranchRefs(repo!.id)).toEqual([]);
  });

  it('reconciles a repository id that is not in the store yet without orphaning', async () => {
    const other = join(base, 'other');
    init(other);

    await sweep.all([root, other]);

    const repos = await store.listRepos();
    expect(repos).toHaveLength(2);
    for (const repo of repos) expect(await store.listBranchRefs(repo.id)).toHaveLength(1);
  });

  it('does not confuse two repositories that share a branch name', async () => {
    const other = join(base, 'other');
    init(other);
    await sweep.all([root, other]);

    git(other, 'branch', '-m', 'main', 'renamed');
    await sweep.all([root, other]);

    const repos = await store.listRepos();
    const first = repos.find((repo) => repo.rootPath === root)!;
    const second = repos.find((repo) => repo.rootPath === other)!;
    expect((await store.listBranchRefs(first.id)).map((branch) => branch.name)).toEqual(['main']);
    expect((await store.listBranchRefs(second.id)).map((branch) => branch.name)).toEqual([
      'renamed',
    ]);
  });
});
