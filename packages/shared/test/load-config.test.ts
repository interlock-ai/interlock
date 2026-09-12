import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configPath, loadConfig } from '../src/config.js';
import { isInterlockError } from '../src/errors.js';

/**
 * The loader against a real directory, because what it decides — is a missing
 * file the defaults, is an unreadable one an error — is a property of the
 * filesystem's answer rather than of the parser.
 */

describe('loadConfig', () => {
  let dataDir: string;

  const refusal = (dir: string): string => {
    try {
      loadConfig(dir);
    } catch (error) {
      if (!isInterlockError(error)) throw error;
      expect(error.code).toBe('CONFIG_INVALID');
      return `${error.message}\n${error.remedy ?? ''}`;
    }
    throw new Error('expected the config to be refused');
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'interlock-config-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts on the defaults when there is no file, which is the normal first start', () => {
    const config = loadConfig(dataDir);
    expect(config.repos).toStrictEqual([]);
    expect(config.daemon.port).toBe(DEFAULT_CONFIG.daemon.port);
    // The data dir is the one asked for, not the default the file would name.
    expect(config.dataDir).toBe(dataDir);
  });

  it('watches the repositories a valid file names', () => {
    writeFileSync(configPath(dataDir), JSON.stringify({ repos: ['/work/one', '/work/two'] }));
    expect(loadConfig(dataDir).repos).toStrictEqual(['/work/one', '/work/two']);
  });

  it('keeps the data dir it was given whatever the file says elsewhere', () => {
    writeFileSync(configPath(dataDir), JSON.stringify({ logLevel: 'debug' }));
    const config = loadConfig(dataDir);
    expect(config.dataDir).toBe(dataDir);
    expect(config.logLevel).toBe('debug');
  });

  it('refuses a malformed file and names the path', () => {
    writeFileSync(configPath(dataDir), '{ not json');
    const text = refusal(dataDir);
    expect(text).toContain('not valid JSON');
    expect(text).toContain(configPath(dataDir));
  });

  it('refuses a relative repository path rather than resolving it against the cwd', () => {
    writeFileSync(configPath(dataDir), JSON.stringify({ repos: ['./repo'] }));
    expect(refusal(dataDir)).toContain('must be absolute');
  });

  it('treats a file that exists but cannot be read as an error, not as the defaults', () => {
    // A daemon that ran on defaults over a config it could not open would look
    // exactly like one that was never configured.
    mkdirSync(configPath(dataDir));
    const text = refusal(dataDir);
    expect(text).toContain('could not be read');
    expect(text).toContain(configPath(dataDir));
  });

  it('treats a file it is not permitted to read the same way', () => {
    writeFileSync(configPath(dataDir), '{}', { mode: 0o000 });
    try {
      expect(refusal(dataDir)).toContain('could not be read');
    } finally {
      chmodSync(configPath(dataDir), 0o600);
    }
  });
});
