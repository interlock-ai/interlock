import { homedir } from 'node:os';
import { join } from 'node:path';
import { InterlockError } from './errors.js';
import type { LogLevel } from './logger.js';
import type { RepoConfigOverride } from './models/repo.js';

/**
 * Global configuration schema, defaults and validation.
 *
 * Validated by hand rather than with a schema library because `shared` is
 * zero-dep and the surface is small. Revisit if this file grows past a few
 * hundred lines.
 */

export interface InterlockConfig {
  /** Repositories to watch. Absolute paths. */
  readonly repos: readonly string[];
  /** Where shadow clones, the SQLite store and logs live. Created with 0700. */
  readonly dataDir: string;
  readonly daemon: DaemonConfig;
  readonly scheduler: SchedulerConfig;
  readonly analyzers: AnalyzersConfig;
  readonly sandbox: SandboxConfig;
  readonly mcp: McpConfig;
  readonly logLevel: LogLevel;
}

export interface DaemonConfig {
  /** Loopback only; the literal type keeps it unconfigurable. */
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface SchedulerConfig {
  /** Quiet period after the last edit before a pair is re-run. */
  readonly debounceMs: number;
  /** Maximum speculative runs executing at once. */
  readonly concurrency: number;
  /** Priority added to pairs whose changes touch a common file. */
  readonly overlapPriorityBoost: number;
  /** Refuse to schedule when the repo has more in-flight branches than this. */
  readonly maxBranches: number;
}

export interface AnalyzersConfig {
  readonly textual: boolean;
  readonly typecheck: boolean;
  readonly build: boolean;
  readonly testTargeted: boolean;
  readonly astSemantic: boolean;
}

export interface SandboxConfig {
  /** Disabling it disables every execution analyzer. */
  readonly enabled: boolean;
  readonly image: string;
  readonly cpuLimit: number;
  readonly memoryLimitMb: number;
  readonly timeoutMs: number;
  /** Always false; typed as a literal so the invariant is testable. */
  readonly network: false;
}

export interface McpConfig {
  readonly enabled: boolean;
  readonly port: number;
  /** Maximum warnings delivered to a single agent session per hour. */
  readonly maxWarningsPerHour: number;
}

export const DEFAULT_DATA_DIR = join(homedir(), '.interlock');

export const DEFAULT_CONFIG: InterlockConfig = {
  repos: [],
  dataDir: DEFAULT_DATA_DIR,
  daemon: { host: '127.0.0.1', port: 47317 },
  scheduler: {
    debounceMs: 2_000,
    concurrency: 2,
    overlapPriorityBoost: 10,
    maxBranches: 12,
  },
  analyzers: {
    textual: true,
    typecheck: true,
    build: false,
    testTargeted: false,
    astSemantic: true,
  },
  sandbox: {
    enabled: true,
    image: 'node:22-bookworm-slim',
    cpuLimit: 2,
    memoryLimitMb: 4096,
    timeoutMs: 180_000,
    network: false,
  },
  mcp: { enabled: true, port: 47318, maxWarningsPerHour: 10 },
  logLevel: 'info',
};

/** Name of the per-repository override file, read from the repository root. */
export const REPO_CONFIG_FILENAME = '.interlock.json';

/**
 * Ceiling on the override file.
 *
 * The file is repository content, so its size is chosen by whoever writes the
 * repository. Reading it into memory before deciding it is too large is the
 * thing the ceiling exists to prevent.
 */
export const MAX_REPO_CONFIG_BYTES = 64 * 1024;

/**
 * Ceiling on one ignore pattern.
 *
 * Enforced again where patterns are matched, because a matcher must be safe on
 * input that never passed through here. Rejecting the pattern at the boundary
 * is what makes it visible: a pattern silently too long to ever match is the
 * same as a typo nobody is told about.
 */
export const MAX_IGNORE_PATTERN_LENGTH = 200;

/**
 * Ceiling on how many ignore patterns a repository may declare.
 *
 * Every pattern is tried against every branch, so the two multiply.
 */
export const MAX_IGNORE_PATTERNS = 256;

const REPO_CONFIG_KEYS = ['ignore', 'ignoreBranches', 'toolchain'] as const;
const TOOLCHAIN_KEYS = ['install', 'typecheck', 'build', 'test'] as const;

/**
 * Parse a repository's override file.
 *
 * Every field is checked rather than trusted: the file is written by the agents
 * Interlock watches, and `ignoreBranches` decides which branches go unexamined.
 * An unrecognised key is a problem rather than something to ignore — a typo
 * that quietly does nothing is indistinguishable from a setting that was never
 * applied.
 *
 * Problems name the key and the shape expected, never the value found. The file
 * may contain anything, and an `InterlockError` reaches the API and the agents.
 *
 * Every problem is reported at once, with one exception `JSON.parse` decides:
 * a repeated key keeps the last occurrence silently, so a file declaring
 * `ignore` twice is read as valid.
 *
 * @throws InterlockError `CONFIG_INVALID` listing every problem at once.
 */
export function parseRepoConfigOverride(source: string, path: string): RepoConfigOverride {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw repoConfigInvalid(['file is not valid JSON'], path);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw repoConfigInvalid(['top level must be a JSON object'], path);
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(REPO_CONFIG_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown key: ${key}`);
    }
  }

  const ignore = readPatternList(record, 'ignore', problems);
  const ignoreBranches = readPatternList(record, 'ignoreBranches', problems);
  const toolchain = readToolchain(record, problems);

  if (problems.length > 0) throw repoConfigInvalid(problems, path);

  return {
    ...(ignore === undefined ? {} : { ignore }),
    ...(ignoreBranches === undefined ? {} : { ignoreBranches }),
    ...(toolchain === undefined ? {} : { toolchain }),
  };
}

function readPatternList(
  record: Record<string, unknown>,
  key: 'ignore' | 'ignoreBranches',
  problems: string[],
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${key} must be an array of strings`);
    return undefined;
  }
  if (value.length > MAX_IGNORE_PATTERNS) {
    problems.push(
      `${key} has ${String(value.length)} entries, more than ${String(MAX_IGNORE_PATTERNS)}`,
    );
    return undefined;
  }

  const patterns: string[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${key}[${String(index)}]`;
    if (typeof entry !== 'string') {
      problems.push(`${at} must be a string`);
    } else if (entry === '') {
      problems.push(`${at} must not be empty`);
    } else if (entry.length > MAX_IGNORE_PATTERN_LENGTH) {
      problems.push(`${at} is longer than ${String(MAX_IGNORE_PATTERN_LENGTH)} characters`);
    } else {
      patterns.push(entry);
    }
  }
  return patterns;
}

function readToolchain(
  record: Record<string, unknown>,
  problems: string[],
): RepoConfigOverride['toolchain'] | undefined {
  const value = record.toolchain;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push('toolchain must be a JSON object');
    return undefined;
  }

  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(TOOLCHAIN_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown key: toolchain.${key}`);
    }
  }

  const install = readCommand(source, 'install', problems);
  const typecheck = readCommand(source, 'typecheck', problems);
  const build = readCommand(source, 'build', problems);
  const test = readCommand(source, 'test', problems);

  const toolchain = {
    ...(install === undefined ? {} : { install }),
    ...(typecheck === undefined ? {} : { typecheck }),
    ...(build === undefined ? {} : { build }),
    ...(test === undefined ? {} : { test }),
  };
  // An empty object and an absent key mean the same thing; keeping both shapes
  // leaves every reader to handle two spellings of nothing.
  return Object.keys(toolchain).length === 0 ? undefined : toolchain;
}

function readCommand(
  source: Record<string, unknown>,
  key: (typeof TOOLCHAIN_KEYS)[number],
  problems: string[],
): string | undefined {
  const command = source[key];
  if (command === undefined) return undefined;
  if (typeof command !== 'string' || command === '') {
    problems.push(`toolchain.${key} must be a non-empty string`);
    return undefined;
  }
  return command;
}

function repoConfigInvalid(problems: string[], path: string): InterlockError {
  return new InterlockError(
    'CONFIG_INVALID',
    `Invalid ${REPO_CONFIG_FILENAME}: ${problems.join('; ')}`,
    {
      details: { path, problems },
      remedy: `Fix ${path}, or delete it to fall back to the global configuration.`,
    },
  );
}

/** Standard config file location. Repos may override a subset via `.interlock.json`. */
export function configPath(dataDir: string = DEFAULT_DATA_DIR): string {
  return join(dataDir, 'config.json');
}

/**
 * Merge partial user config over the defaults and validate the result.
 *
 * @throws InterlockError `CONFIG_INVALID` listing every problem at once, so a
 *         broken config is fixed in one pass.
 */
export function resolveConfig(input: DeepPartial<InterlockConfig> = {}): InterlockConfig {
  const config: InterlockConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    repos: input.repos ?? DEFAULT_CONFIG.repos,
    daemon: { ...DEFAULT_CONFIG.daemon, ...input.daemon, host: '127.0.0.1' },
    scheduler: { ...DEFAULT_CONFIG.scheduler, ...input.scheduler },
    analyzers: { ...DEFAULT_CONFIG.analyzers, ...input.analyzers },
    sandbox: { ...DEFAULT_CONFIG.sandbox, ...input.sandbox, network: false },
    mcp: { ...DEFAULT_CONFIG.mcp, ...input.mcp },
  };

  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new InterlockError('CONFIG_INVALID', `Invalid Interlock config: ${problems.join('; ')}`, {
      details: { problems },
      remedy: `Edit ${configPath(config.dataDir)} and restart the daemon.`,
    });
  }
  return config;
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateConfig(config: InterlockConfig): string[] {
  const problems: string[] = [];

  for (const repo of config.repos) {
    if (!repo.startsWith('/')) problems.push(`repo path must be absolute: ${repo}`);
  }
  if (!isPort(config.daemon.port)) problems.push(`daemon.port out of range: ${config.daemon.port}`);
  if (!isPort(config.mcp.port)) problems.push(`mcp.port out of range: ${config.mcp.port}`);
  if (config.daemon.port === config.mcp.port) problems.push('daemon.port and mcp.port must differ');
  if (config.scheduler.debounceMs < 0) problems.push('scheduler.debounceMs must be >= 0');
  if (config.scheduler.concurrency < 1) problems.push('scheduler.concurrency must be >= 1');
  if (config.scheduler.maxBranches < 2) problems.push('scheduler.maxBranches must be >= 2');
  if (config.sandbox.cpuLimit <= 0) problems.push('sandbox.cpuLimit must be > 0');
  if (config.sandbox.memoryLimitMb < 512) problems.push('sandbox.memoryLimitMb must be >= 512');
  if (config.sandbox.timeoutMs < 1_000) problems.push('sandbox.timeoutMs must be >= 1000');
  if (config.mcp.maxWarningsPerHour < 0) problems.push('mcp.maxWarningsPerHour must be >= 0');

  // Execution analyzers require the sandbox: merged code never runs on the host.
  if (!config.sandbox.enabled) {
    const needsSandbox = (['typecheck', 'build', 'testTargeted'] as const).filter(
      (key) => config.analyzers[key],
    );
    if (needsSandbox.length > 0) {
      problems.push(
        `analyzers ${needsSandbox.join(', ')} require sandbox.enabled — Interlock never executes merged code on the host`,
      );
    }
  }

  return problems;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 1024 && value < 65_536;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
