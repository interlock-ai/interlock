import { EventEmitter } from 'node:events';
import { lstatSync, readdirSync, watch } from 'node:fs';
import type { FSWatcher, WatchEventType } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/**
 * A recursive watch built from one non-recursive watch per directory: the
 * worktree watcher's default on Linux.
 *
 * Node's own recursive mode on Linux is built the same way, in JavaScript, but
 * it stats each entry an event names inside its inotify callback with nothing
 * around the call. A watched directory that loses its permissions — a worktree
 * someone `chmod`s, a tool locking a directory it writes — makes that `lstat`
 * throw `EACCES` out of the callback, past the watcher's `error` event, as an
 * uncaught exception that ends the daemon. Reproduced on Node 24.22 and 26.12,
 * for the root and for any directory under it. Here every filesystem call is
 * caught, and a failure reaches the caller as an `error` event naming the
 * directory it is about, where the worktree watcher already decides what an
 * unreadable or vanished directory means.
 *
 * Events are the recursive watch's: a filename relative to the root, and the
 * root's own name for a change to the root itself. A symbolic link is an entry
 * like any other and is never followed. Errors are delivered a tick late, so a
 * failure met while the tree is first walked is heard by listeners attached
 * after this returns; a root that cannot be watched or read throws, as
 * `fs.watch` does, so the caller can fall back to polling at once.
 */
export function watchDirectoryTree(
  root: string,
  system: TreeFileSystem = NODE_FILE_SYSTEM,
): FSWatcher {
  return new TreeWatcher(root, system);
}

/**
 * The three filesystem calls a tree watch makes. Injectable, as the worktree
 * watcher's factory is, because the failures that matter — a directory losing
 * its permissions between being watched and being listed, a watch erroring on
 * its own — are races a real directory cannot be made to lose on demand.
 */
export interface TreeFileSystem {
  watch(path: string): FSWatcher;
  readdir(path: string): readonly { readonly name: string; isDirectory(): boolean }[];
  /** Undefined for a path that does not exist; throws for one that cannot be reached. */
  lstat(path: string): { isDirectory(): boolean } | undefined;
}

const NODE_FILE_SYSTEM: TreeFileSystem = {
  watch: (path) => watch(path, { persistent: true }),
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  lstat: (path) => lstatSync(path, { throwIfNoEntry: false }),
};

class TreeWatcher extends EventEmitter {
  readonly #root: string;
  readonly #system: TreeFileSystem;
  /** Every directory watched, by absolute path. */
  readonly #watchers = new Map<string, FSWatcher>();
  #closed = false;
  #referenced = true;

  constructor(root: string, system: TreeFileSystem) {
    super();
    this.#root = root;
    this.#system = system;
    this.#watchDirectory(root, true);
  }

  close(): void {
    this.#closed = true;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  ref(): this {
    this.#referenced = true;
    for (const watcher of this.#watchers.values()) watcher.ref();
    return this;
  }

  unref(): this {
    this.#referenced = false;
    for (const watcher of this.#watchers.values()) watcher.unref();
    return this;
  }

  /**
   * Watch `start` and every directory under it not watched yet. Iterative: a
   * repository decides how deep its directories nest.
   */
  #watchDirectory(start: string, initial: boolean): void {
    const pending = [start];
    while (pending.length > 0 && !this.#closed) {
      const dir = pending.pop()!;
      if (this.#watchers.has(dir)) continue;
      // The root failing at the start is the caller's to see now; anything
      // later, or deeper, is an `error` event like any other.
      const atStart = initial && dir === this.#root;
      let watcher: FSWatcher;
      try {
        watcher = this.#system.watch(dir);
      } catch (error) {
        if (atStart) throw error;
        this.#fail(error, dir);
        continue;
      }
      watcher.on('change', (event: WatchEventType, name: string | Buffer | null) => {
        this.#onEvent(dir, event, typeof name === 'string' ? name : null);
      });
      watcher.on('error', (error: unknown) => {
        this.#fail(error, dir);
      });
      if (!this.#referenced) watcher.unref();
      this.#watchers.set(dir, watcher);

      let entries;
      try {
        entries = this.#system.readdir(dir);
      } catch (error) {
        if (atStart) {
          this.close();
          throw error;
        }
        this.#fail(error, dir);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(join(dir, entry.name));
      }
    }
  }

  /** An event from the watch on `dir`, about `name` in it or about `dir` itself. */
  #onEvent(dir: string, event: WatchEventType, name: string | null): void {
    if (this.#closed) return;
    if (name === null) {
      // Something in `dir` changed and the platform could not say what.
      this.emit('change', event, null);
      return;
    }
    const path = join(dir, name);
    let stats;
    try {
      stats = this.#system.lstat(path);
    } catch (error) {
      // `dir` itself can no longer be searched: the failure is the directory's.
      this.#fail(error, dir);
      return;
    }
    if (stats === undefined && name === basename(dir)) {
      // A watch reports a change to its own directory under that directory's
      // name — or a same-named entry inside it went away, which reporting the
      // directory covers too.
      let self;
      try {
        self = this.#system.lstat(dir);
      } catch (error) {
        this.#fail(error, dir);
        return;
      }
      if (self === undefined) {
        this.#gone(dir);
        return;
      }
      this.emit('change', event, dir === this.#root ? name : relative(this.#root, dir));
      return;
    }
    if (stats === undefined) {
      this.#forget(path);
    } else if (stats.isDirectory()) {
      // A directory made, or put back, after the walk: a new inode a watch on
      // the old one would never hear from. One already watched is passed over.
      this.#watchDirectory(path, false);
    }
    this.emit('change', event, relative(this.#root, path));
  }

  /** `dir` no longer exists: stop watching it, and say so for the root. */
  #gone(dir: string): void {
    this.#forget(dir);
    if (dir !== this.#root) {
      this.emit('change', 'rename', relative(this.#root, dir));
      return;
    }
    const error: NodeJS.ErrnoException = Object.assign(
      new Error(`ENOENT: no such file or directory, watch '${dir}'`),
      { code: 'ENOENT', syscall: 'watch', path: dir },
    );
    this.#deliver(error);
  }

  /** Stop watching `path` and everything under it. */
  #forget(path: string): void {
    const inside = `${path}${sep}`;
    for (const [dir, watcher] of this.#watchers) {
      if (dir === path || dir.startsWith(inside)) {
        watcher.close();
        this.#watchers.delete(dir);
      }
    }
  }

  /**
   * A filesystem call about `dir` failed. A directory that vanished is
   * forgotten; anything else is an `error` naming `dir`, whatever path the
   * call itself was given, since which directory failed is what the caller
   * places inside the tree or at its root.
   */
  #fail(error: unknown, dir: string): void {
    if (this.#closed) return;
    const failure = (
      error instanceof Error ? error : new Error(String(error))
    ) as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT') {
      this.#gone(dir);
      return;
    }
    failure.path = dir;
    this.#deliver(failure);
  }

  #deliver(error: NodeJS.ErrnoException): void {
    process.nextTick(() => {
      if (!this.#closed) this.emit('error', error);
    });
  }
}
