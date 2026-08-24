import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_IGNORE_PATTERNS,
  parseRepoConfigOverride,
  resolveConfig,
  validateConfig,
} from './config.js';
import { isInterlockError } from './errors.js';

describe('resolveConfig', () => {
  it('fills defaults for anything not provided', () => {
    const config = resolveConfig({ repos: ['/tmp/repo'] });
    expect(config.repos).toEqual(['/tmp/repo']);
    expect(config.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    expect(config.scheduler.debounceMs).toBe(DEFAULT_CONFIG.scheduler.debounceMs);
  });

  it('merges nested sections instead of replacing them', () => {
    const config = resolveConfig({ scheduler: { concurrency: 8 } });
    expect(config.scheduler.concurrency).toBe(8);
    expect(config.scheduler.maxBranches).toBe(DEFAULT_CONFIG.scheduler.maxBranches);
  });

  it('reports every problem at once', () => {
    try {
      resolveConfig({ repos: ['relative/path'], daemon: { port: 80 } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isInterlockError(error)).toBe(true);
      const problems = (error as { details: { problems: string[] } }).details.problems;
      expect(problems).toHaveLength(2);
    }
  });
});

describe('security invariants', () => {
  it('cannot be configured off loopback', () => {
    const config = resolveConfig({ daemon: { host: '0.0.0.0' as '127.0.0.1' } });
    expect(config.daemon.host).toBe('127.0.0.1');
  });

  it('cannot enable sandbox networking', () => {
    const config = resolveConfig({ sandbox: { network: true as false } });
    expect(config.sandbox.network).toBe(false);
  });

  it('refuses execution analyzers when the sandbox is disabled', () => {
    const problems = validateConfig({
      ...DEFAULT_CONFIG,
      sandbox: { ...DEFAULT_CONFIG.sandbox, enabled: false },
    });
    expect(problems.join(' ')).toContain('require sandbox.enabled');
  });
});

/** Reads the problem list off a rejected parse, or fails the test. */
function problemsFrom(source: string): string[] {
  try {
    parseRepoConfigOverride(source, '/repo/.interlock.json');
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(isInterlockError(error)).toBe(true);
    return (error as { details: { problems: string[] } }).details.problems;
  }
}

describe('parseRepoConfigOverride', () => {
  const parse = (source: string): unknown =>
    parseRepoConfigOverride(source, '/repo/.interlock.json');

  it('reads the fields a repository may override', () => {
    expect(
      parse(
        JSON.stringify({
          ignore: ['dist/**'],
          ignoreBranches: ['release/*'],
          toolchain: { install: 'pnpm i', test: 'pnpm test' },
        }),
      ),
    ).toEqual({
      ignore: ['dist/**'],
      ignoreBranches: ['release/*'],
      toolchain: { install: 'pnpm i', test: 'pnpm test' },
    });
  });

  it('reads an empty object as no overrides', () => {
    expect(parse('{}')).toEqual({});
  });

  it.each([
    ['not JSON at all', 'nope', 'not valid JSON'],
    ['a JSON array', '[]', 'top level must be a JSON object'],
    ['JSON null', 'null', 'top level must be a JSON object'],
    ['a bare string', '"hello"', 'top level must be a JSON object'],
  ])('refuses %s', (_name, source, expected) => {
    expect(problemsFrom(source).join('; ')).toContain(expected);
  });

  it('refuses a key it does not recognise', () => {
    // A typo that is quietly ignored is indistinguishable from a setting that
    // was never applied.
    expect(problemsFrom(JSON.stringify({ ignoreBranch: ['x'] }))).toContain(
      'unknown key: ignoreBranch',
    );
    expect(problemsFrom(JSON.stringify({ toolchain: { lint: 'x' } }))).toContain(
      'unknown key: toolchain.lint',
    );
  });

  it('names the key and the shape, never the value', () => {
    // The file is repository content and the error reaches agents, so a secret
    // pasted into it must not travel with the complaint.
    const problems = problemsFrom(
      JSON.stringify({ ignoreBranches: ['ok', 'sk-secret-token', 42] }),
    );
    expect(problems).toContain('ignoreBranches[2] must be a string');
    expect(problems.join('; ')).not.toContain('sk-secret-token');
  });

  it.each([
    ['a non-array list', { ignore: 'dist' }, 'ignore must be an array of strings'],
    ['an empty pattern', { ignore: [''] }, 'ignore[0] must not be empty'],
    ['a non-object toolchain', { toolchain: [] }, 'toolchain must be a JSON object'],
    ['an empty command', { toolchain: { test: '' } }, 'toolchain.test must be a non-empty string'],
  ])('refuses %s', (_name, value, expected) => {
    expect(problemsFrom(JSON.stringify(value))).toContain(expected);
  });

  it('refuses a pattern too long to be matched', () => {
    // The matcher caps length too and would answer false, which is a rule that
    // silently never fires. Refusing at the boundary is what makes it visible.
    const pattern = 'a'.repeat(MAX_IGNORE_PATTERN_LENGTH + 1);
    expect(problemsFrom(JSON.stringify({ ignoreBranches: [pattern] }))).toContain(
      `ignoreBranches[0] is longer than ${String(MAX_IGNORE_PATTERN_LENGTH)} characters`,
    );
  });

  it('refuses more patterns than it will match against every branch', () => {
    const many = Array.from({ length: MAX_IGNORE_PATTERNS + 1 }, (_, i) => `b${String(i)}`);
    expect(problemsFrom(JSON.stringify({ ignoreBranches: many })).join('; ')).toContain(
      `more than ${String(MAX_IGNORE_PATTERNS)}`,
    );
  });

  it('reports every problem at once', () => {
    const problems = problemsFrom(
      JSON.stringify({ nope: 1, ignore: 5, toolchain: { build: 7, wat: 'x' } }),
    );
    expect(problems).toHaveLength(4);
  });
});
