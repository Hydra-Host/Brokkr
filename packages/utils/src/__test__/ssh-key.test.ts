import { describe, expect, it } from 'vitest';
import { normalizeSshKey } from '../ssh-key';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVkht1ZdckTEe2WZwwFgJX+cot8xSf5CAYaYqGtQKJ6';
const KEY_BODY = KEY.slice('ssh-ed25519 '.length);

describe('normalizeSshKey', () => {
  it.each(['\n', '\r\n', '\r'])('normalizes a key with %j line endings', (lineEnding) => {
    expect(normalizeSshKey(`# workstation${lineEnding}${KEY}${lineEnding}`)).toBe(KEY);
  });

  it('removes comment lines', () => {
    expect(normalizeSshKey(`# first\n# second\n${KEY}`)).toBe(KEY);
  });

  it('joins wrapped key material', () => {
    expect(normalizeSshKey(`ssh-ed25519 ${KEY_BODY.slice(0, 12)}\n${KEY_BODY.slice(12)}`)).toBe(KEY);
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeSshKey('')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeSshKey(`  ${KEY}  `)).toBe(KEY);
  });

  it('is idempotent', () => {
    const input = `# workstation\r\nssh-ed25519 ${KEY_BODY.slice(0, 12)}\r\n${KEY_BODY.slice(12)}\r\n`;
    const normalized = normalizeSshKey(input);

    expect(normalizeSshKey(normalized)).toBe(normalized);
  });
});
