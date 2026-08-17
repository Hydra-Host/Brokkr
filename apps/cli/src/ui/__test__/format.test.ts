import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCustomizationsFlag } from '../format.js';

const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

afterEach(() => {
  exitSpy.mockClear();
});

describe('parseCustomizationsFlag', () => {
  it('returns null when the flag is undefined', () => {
    expect(parseCustomizationsFlag(undefined)).toBeNull();
  });

  it('returns null when the flag is an empty string', () => {
    expect(parseCustomizationsFlag('')).toBeNull();
  });

  it('parses valid JSON with string values', () => {
    const result = parseCustomizationsFlag('{"gpuDriver":"nvidia-driver-580"}');
    expect(result).toEqual({ gpuDriver: 'nvidia-driver-580' });
  });

  it('parses valid JSON with string-array values', () => {
    const result = parseCustomizationsFlag('{"miscSoftware":["docker","ollama"]}');
    expect(result).toEqual({ miscSoftware: ['docker', 'ollama'] });
  });

  it('parses valid JSON with mixed string and array values', () => {
    const input = JSON.stringify({ gpuDriver: 'nvidia-driver-580', miscSoftware: ['docker'] });
    expect(parseCustomizationsFlag(input)).toEqual({
      gpuDriver: 'nvidia-driver-580',
      miscSoftware: ['docker'],
    });
  });

  it('exits on malformed JSON', () => {
    expect(() => parseCustomizationsFlag('{not json}')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when JSON is a bare array (wrong shape)', () => {
    expect(() => parseCustomizationsFlag('["a","b"]')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when JSON is a number (wrong shape)', () => {
    expect(() => parseCustomizationsFlag('42')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when JSON is a bare string (wrong shape)', () => {
    expect(() => parseCustomizationsFlag('"just a string"')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits when object values have the wrong type (nested object)', () => {
    expect(() => parseCustomizationsFlag('{"gpuDriver":{"nested":true}}')).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('returns null for the JSON literal "null"', () => {
    expect(parseCustomizationsFlag('null')).toBeNull();
  });

  it('accepts an empty object and returns it as-is', () => {
    expect(parseCustomizationsFlag('{}')).toEqual({});
  });
});
