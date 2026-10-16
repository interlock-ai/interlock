import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { watchDirectoryTree } from './tree-watch.js';
import type { TreeFileSystem } from './tree-watch.js';

/**
 * The tree watch against a filesystem that can be made to fail on cue: the
 * races and platform answers a real directory cannot produce on demand. The
 * real thing, on Linux, is in `test/tree-watch.test.ts`.
 */

class FakeWatcher extends EventEmitter {
  closed = false;
  referenced = true;
  close(): void {
    this.closed = true;
  }
  ref(): this {
    this.referenced = true;
    return this;
  }
  unref(): this {
    this.referenced = false;
    return this;
  }
}

const errno = (code: string, path = '/elsewhere'): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code, path });

interface Fake {
  readonly system: TreeFileSystem;
  readonly watchers: Map<string, FakeWatcher>;
  /** Every path a watch was asked for, in order. */
  readonly watched: string[];
  /** Directories, by path, and the files in them. */
  readonly dirs: Map<string, Set<string>>;
  readonly fail: {
    readonly watch: Map<string, unknown>;
    readonly readdir: Map<string, unknown>;
    readonly lstat: Map<string, unknown>;
  };
}

function fakeTree(...dirs: string[]): Fake {
  const tree = new Map<string, Set<string>>(dirs.map((dir) => [dir, new Set<string>()]));
  const watchers = new Map<string, FakeWatcher>();
  const watched: string[] = [];
  const fail = { watch: new Map(), readdir: new Map(), lstat: new Map() };
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
  return {
    watchers,
    watched,
    dirs: tree,
    fail,
    system: {
      watch(path) {
        watched.push(path);
        if (fail.watch.has(path)) throw fail.watch.get(path);
        const watcher = new FakeWatcher();
        watchers.set(path, watcher);
        return watcher;
      },
      readdir(path) {
        if (fail.readdir.has(path)) throw fail.readdir.get(path);
        return [...tree.keys()]
          .filter((dir) => dir !== path && parentOf(dir) === path)
          .map((dir) => ({ name: dir.slice(path.length + 1), isDirectory: () => true }));
      },
      lstat(path) {
        if (fail.lstat.has(path)) throw fail.lstat.get(path);
        if (tree.has(path)) return { isDirectory: () => true };
        return tree.get(parentOf(path))?.has(path.slice(parentOf(path).length + 1)) === true
          ? { isDirectory: () => false }
          : undefined;
      },
    },
  };
}

/** A tree watch over a fake, with what it says recorded. */
function started(fake: Fake, root = '/r') {
  const events: (string | null)[] = [];
  const errors: NodeJS.ErrnoException[] = [];
  const watcher = watchDirectoryTree(root, fake.system);
  watcher.on('change', (_event, name) => events.push(typeof name === 'string' ? name : null));
  watcher.on('error', (error: NodeJS.ErrnoException) => errors.push(error));
  return { watcher, events, errors };
}

const tick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve));

describe('watchDirectoryTree', () => {
  it('watches every directory once, and names an event relative to the root', () => {
    const fake = fakeTree('/r', '/r/src', '/r/src/deep');
    fake.dirs.get('/r/src')!.add('a.txt');
    const { events } = started(fake);
    expect([...fake.watchers.keys()].sort()).toEqual(['/r', '/r/src', '/r/src/deep']);
    fake.watchers.get('/r/src')!.emit('change', 'change', 'a.txt');
    expect(events).toEqual(['src/a.txt']);
  });

  it('passes on an event the platform could not name as unnamed', () => {
    const fake = fakeTree('/r');
    const { events } = started(fake);
    fake.watchers.get('/r')!.emit('change', 'rename', null);
    expect(events).toEqual([null]);
  });

  it('names the root for a change to itself, and a directory inside by its own path', () => {
    const fake = fakeTree('/r', '/r/src', '/r/src/deep');
    const { events } = started(fake);
    fake.watchers.get('/r')!.emit('change', 'change', 'r');
    fake.watchers.get('/r/src')!.emit('change', 'change', 'src');
    fake.watchers.get('/r/src/deep')!.emit('change', 'change', 'deep');
    expect(events).toEqual(['r', 'src', 'src/deep']);
  });

  it('does not watch a directory again when an event names one it watches', () => {
    const fake = fakeTree('/r', '/r/src');
    const { events } = started(fake);
    fake.watchers.get('/r')!.emit('change', 'change', 'src');
    expect(events).toEqual(['src']);
    expect(fake.watched).toEqual(['/r', '/r/src']);
  });

  it('throws for a root it cannot watch, or cannot list, and holds nothing open', () => {
    const unwatchable = fakeTree('/r');
    unwatchable.fail.watch.set('/r', errno('EACCES'));
    expect(() => started(unwatchable)).toThrow('EACCES');

    const unlistable = fakeTree('/r');
    unlistable.fail.readdir.set('/r', errno('EACCES'));
    expect(() => started(unlistable)).toThrow('EACCES');
    expect(unlistable.watchers.get('/r')?.closed).toBe(true);
  });

  it('delivers a failure inside, met on the first walk, a tick later and named by its directory', async () => {
    const fake = fakeTree('/r', '/r/a', '/r/b', '/r/b/below');
    fake.fail.watch.set('/r/a', errno('ENOSPC'));
    fake.fail.readdir.set('/r/b', errno('EACCES'));
    const { errors } = started(fake);
    // Not yet: no listener could have been attached when they happened.
    expect(errors).toEqual([]);
    await tick();
    expect(errors.map((error) => [error.code, error.path]).sort()).toEqual([
      ['EACCES', '/r/b'],
      ['ENOSPC', '/r/a'],
    ]);
    // What could not be listed is watched, and what is under it is not reached.
    expect(fake.watchers.has('/r/b')).toBe(true);
    expect(fake.watchers.has('/r/b/below')).toBe(false);
  });

  it("names a directory's own failures by that directory, whatever path the call was given", async () => {
    const fake = fakeTree('/r', '/r/src');
    const { errors } = started(fake);
    fake.fail.lstat.set('/r/src/x.txt', errno('EACCES', '/r/src/x.txt'));
    fake.watchers.get('/r/src')!.emit('change', 'change', 'x.txt');
    fake.fail.lstat.set('/r/src', errno('EACCES', '/r/src'));
    fake.watchers.get('/r/src')!.emit('change', 'change', 'src');
    fake.watchers.get('/r/src')!.emit('error', errno('EPERM', '/r/src/somewhere'));
    await tick();
    expect(errors.map((error) => [error.code, error.path])).toEqual([
      ['EACCES', '/r/src'],
      ['EACCES', '/r/src'],
      ['EPERM', '/r/src'],
    ]);
  });

  it('carries a thrown value that is not an Error as one', async () => {
    const fake = fakeTree('/r');
    const { errors } = started(fake);
    fake.watchers.get('/r')!.emit('error', 'not an error');
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toBe('not an error');
    expect(errors[0]?.path).toBe('/r');
  });

  it('forgets a directory that went away, and everything under it', () => {
    const fake = fakeTree('/r', '/r/src', '/r/src/deep', '/r/srcx');
    const { events } = started(fake);
    fake.dirs.delete('/r/src');
    fake.dirs.delete('/r/src/deep');
    fake.watchers.get('/r')!.emit('change', 'rename', 'src');
    expect(events).toEqual(['src']);
    expect(fake.watchers.get('/r/src')?.closed).toBe(true);
    expect(fake.watchers.get('/r/src/deep')?.closed).toBe(true);
    // A sibling sharing the name's prefix is not inside it.
    expect(fake.watchers.get('/r/srcx')?.closed).toBe(false);
  });

  it("reports a directory's own ENOENT as that directory renamed, and the root's as an error", async () => {
    const fake = fakeTree('/r', '/r/src');
    const { events, errors } = started(fake);
    fake.watchers.get('/r/src')!.emit('error', errno('ENOENT'));
    expect(events).toEqual(['src']);
    expect(fake.watchers.get('/r/src')?.closed).toBe(true);

    fake.dirs.delete('/r');
    fake.watchers.get('/r')!.emit('change', 'rename', 'r');
    await tick();
    expect(errors.map((error) => [error.code, error.path])).toEqual([['ENOENT', '/r']]);
    expect(fake.watchers.get('/r')?.closed).toBe(true);
  });

  it('watches a directory made after the walk, as referenced as the tree is', () => {
    const fake = fakeTree('/r');
    const { watcher, events } = started(fake);
    watcher.unref();
    expect(fake.watchers.get('/r')?.referenced).toBe(false);
    fake.dirs.set('/r/fresh', new Set());
    fake.watchers.get('/r')!.emit('change', 'rename', 'fresh');
    expect(events).toEqual(['fresh']);
    expect(fake.watchers.get('/r/fresh')?.referenced).toBe(false);
    watcher.ref();
    expect([...fake.watchers.values()].every((each) => each.referenced)).toBe(true);
  });

  it('reports a new directory that vanished before it could be watched as renamed', () => {
    const fake = fakeTree('/r');
    const { events } = started(fake);
    fake.dirs.set('/r/brief', new Set());
    fake.fail.watch.set('/r/brief', errno('ENOENT'));
    fake.watchers.get('/r')!.emit('change', 'rename', 'brief');
    expect(events).toEqual(['brief', 'brief']);
  });

  it('says nothing once closed, not even an error it had already met', async () => {
    const fake = fakeTree('/r', '/r/src');
    const { watcher, events, errors } = started(fake);
    fake.watchers.get('/r/src')!.emit('error', errno('EPERM'));
    watcher.close();
    await tick();
    fake.watchers.get('/r')!.emit('change', 'change', 'late.txt');
    fake.watchers.get('/r')!.emit('error', errno('EPERM'));
    // A directory vanishing would otherwise be announced as a change at once.
    fake.watchers.get('/r/src')!.emit('error', errno('ENOENT'));
    await tick();
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
    expect([...fake.watchers.values()].every((each) => each.closed)).toBe(true);
  });
});
