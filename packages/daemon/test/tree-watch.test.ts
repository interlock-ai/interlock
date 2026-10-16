import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchDirectoryTree } from '../src/watcher/tree-watch.js';

/**
 * The recursive watch the worktree watcher uses on Linux, on its own, against a
 * real directory. Linux only: it is the default nowhere else, and other
 * platforms report a directory's own changes differently. Not as root, whom a
 * mode does not stop.
 */

const SETTLE_MS = 300;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)(
  'a directory tree watched one directory at a time',
  () => {
    let base: string;
    let root: string;
    let watcher: FSWatcher | null;
    let events: (string | null)[];
    let errors: NodeJS.ErrnoException[];

    const start = (): FSWatcher => {
      const started = watchDirectoryTree(root);
      started.on('change', (_event, name) => {
        events.push(typeof name === 'string' ? name : null);
      });
      started.on('error', (error: NodeJS.ErrnoException) => {
        errors.push(error);
      });
      watcher = started;
      return started;
    };

    /** Restore a mode however a test ends, so the fixture can be removed. */
    const withMode = async (path: string, run: () => Promise<void>): Promise<void> => {
      try {
        chmodSync(path, 0o000);
        await run();
      } finally {
        chmodSync(path, 0o755);
      }
    };

    beforeEach(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-tree-')));
      root = join(base, 'tree');
      mkdirSync(join(root, 'src', 'deep'), { recursive: true });
      events = [];
      errors = [];
      watcher = null;
    });

    afterEach(() => {
      watcher?.close();
      rmSync(base, { recursive: true, force: true });
    });

    it('names a change anywhere in the tree relative to its root', async () => {
      start();
      writeFileSync(join(root, 'src', 'deep', 'a.txt'), 'a\n');
      writeFileSync(join(root, 'top.txt'), 'b\n');
      await settle();
      expect(events).toContain(join('src', 'deep', 'a.txt'));
      expect(events).toContain('top.txt');
      expect(errors).toEqual([]);
    });

    it('watches a directory made after it started, and one put back after removal', async () => {
      start();
      mkdirSync(join(root, 'fresh', 'inner'), { recursive: true });
      await settle();
      writeFileSync(join(root, 'fresh', 'inner', 'x.txt'), 'x\n');
      rmSync(join(root, 'src'), { recursive: true, force: true });
      await settle();
      mkdirSync(join(root, 'src'));
      await settle();
      events.length = 0;
      writeFileSync(join(root, 'src', 'reborn.txt'), 'y\n');
      await settle();
      expect(events).toContain(join('src', 'reborn.txt'));
      expect(errors).toEqual([]);
    });

    it('reports the root under its own name when the root itself changes', async () => {
      start();
      utimesSync(root, new Date(), new Date());
      await settle();
      expect(events).toContain(basename(root));
    });

    it('reports a directory inside under its own path when it changes', async () => {
      start();
      utimesSync(join(root, 'src'), new Date(), new Date());
      await settle();
      expect(events).toContain('src');
      expect(events).not.toContain(join('src', 'src'));
    });

    it('reports a link as a change and never follows it', async () => {
      const outside = join(base, 'outside');
      mkdirSync(outside);
      start();
      symlinkSync(outside, join(root, 'link'));
      await settle();
      expect(events).toContain('link');
      events.length = 0;
      writeFileSync(join(outside, 'secret.txt'), 'z\n');
      await settle();
      expect(events).toEqual([]);
    });

    it('fails a directory inside that loses its permissions as an error naming that directory', async () => {
      start();
      await withMode(join(root, 'src'), async () => {
        await settle();
        expect(errors.map((error) => [error.code, error.path])).toContainEqual([
          'EACCES',
          join(root, 'src'),
        ]);
      });
    });

    it('fails the root losing its permissions as an error naming the root', async () => {
      start();
      await withMode(root, async () => {
        await settle();
        expect(errors.map((error) => [error.code, error.path])).toContainEqual(['EACCES', root]);
      });
    });

    it('reports the root disappearing as ENOENT naming it, and then nothing more', async () => {
      start();
      rmSync(root, { recursive: true, force: true });
      await settle();
      expect(errors.map((error) => [error.code, error.path])).toContainEqual(['ENOENT', root]);
    });

    it('throws at once for a root it cannot read, as fs.watch would', async () => {
      await withMode(root, () => {
        expect(() => start()).toThrow(expect.objectContaining({ code: 'EACCES' }));
        return Promise.resolve();
      });
    });

    it('throws at once for a root that is not there', () => {
      rmSync(root, { recursive: true, force: true });
      expect(() => start()).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    });

    it('delivers a failure met on the first walk to listeners attached after it', async () => {
      await withMode(join(root, 'src'), async () => {
        start();
        await settle();
        expect(errors.map((error) => [error.code, error.path])).toContainEqual([
          'EACCES',
          join(root, 'src'),
        ]);
        // The rest of the tree is still watched.
        writeFileSync(join(root, 'top.txt'), 'b\n');
        await settle();
        expect(events).toContain('top.txt');
      });
    });

    it('says nothing once closed, and can be unreferenced and referenced again', async () => {
      const started = start();
      expect(started.unref()).toBe(started);
      expect(started.ref()).toBe(started);
      started.unref();
      mkdirSync(join(root, 'after-unref'));
      await settle();
      started.close();
      events.length = 0;
      writeFileSync(join(root, 'src', 'late.txt'), 'late\n');
      await settle();
      expect(events).toEqual([]);
      expect(errors).toEqual([]);
    });
  },
);
