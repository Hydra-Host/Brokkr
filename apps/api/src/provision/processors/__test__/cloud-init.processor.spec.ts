import { type CloudInit } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { CloudInitProcessor } from '../cloud-init.processor';

function decode(base64: string): unknown {
  return JSON.parse(Buffer.from(base64, 'base64').toString());
}

describe('CloudInitProcessor.process', () => {
  const processor = new CloudInitProcessor();

  describe('null / undefined short-circuit', () => {
    it('returns null for null without touching the validator', () => {
      expect(processor.process(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(processor.process(undefined)).toBeNull();
    });
  });

  describe('YAML string path', () => {
    it('validates, then base64-encodes a round-trippable payload', () => {
      const out = processor.process('hostname: test-host\npackages:\n  - vim');
      expect(out).not.toBeNull();
      expect(decode(out!)).toEqual({ hostname: 'test-host', packages: ['vim'] });
    });

    it('throws BadRequestException with the parse-error wrapping on malformed YAML', () => {
      expect(() => processor.process('foo: bar: baz')).toThrow(/Failed to parse cloud-init YAML/);
    });

    it('throws BadRequestException when valid YAML parses to a non-object scalar', () => {
      expect(() => processor.process('just a string')).toThrow(/Invalid cloud-init configuration/);
    });

    it('returns null for YAML that parses to null/undefined', () => {
      expect(processor.process('null')).toBeNull();
      expect(processor.process('')).toBeNull();
    });
  });

  describe('JSON object path', () => {
    it('validates, then base64-encodes a round-trippable payload', () => {
      const input: CloudInit = { hostname: 'h', runcmd: ['echo hi'] };
      const out = processor.process(input);
      expect(out).not.toBeNull();
      expect(decode(out!)).toEqual({ hostname: 'h', runcmd: ['echo hi'] });
    });

    it('preserves unknown cloud-init modules via schema passthrough', () => {
      const input: CloudInit = { hostname: 'h', power_state: { mode: 'reboot' } };
      const out = processor.process(input);
      expect(decode(out!)).toEqual({ hostname: 'h', power_state: { mode: 'reboot' } });
    });

    it('throws BadRequestException when a typed field has the wrong shape', () => {
      const bad = { runcmd: 'echo hi' } as unknown as CloudInit;
      expect(() => processor.process(bad)).toThrow(/Invalid cloud-init configuration/);
    });
  });

  describe('dispatcher base64 contract', () => {
    it('emits base64 that JSON.parses back to the validated object', () => {
      const out = processor.process('hostname: contract-host');
      expect(out).toBe(Buffer.from(JSON.stringify({ hostname: 'contract-host' })).toString('base64'));
    });
  });

  describe('YAML alias bomb defense', () => {
    it('rejects an alias-expansion bomb with 400 instead of expanding it (no RangeError/500, no DoS)', () => {
      const lines = ['l0: &l0 [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]'];
      for (let i = 1; i <= 7; i++) {
        const refs = Array.from({ length: 10 }, () => `*l${i - 1}`).join(', ');
        lines.push(`l${i}: &l${i} [${refs}]`);
      }
      expect(() => processor.process(lines.join('\n'))).toThrow(/too large or too deeply nested/);
    });

    it('rejects a large-scalar alias amplification bomb during stringify, before materializing the expansion', () => {
      const refs = Array.from({ length: 5_000 }, () => '  - *b').join('\n');
      const input = `big: &b "${'A'.repeat(60_000)}"\nrefs:\n${refs}`;
      expect(() => processor.process(input)).toThrow(/must not exceed 64 KB/);
    });

    it('allows benign non-circular anchor reuse (DRY config), not just bombs', () => {
      const out = processor.process('defaults: &d\n  timeout: 30\na: *d\nb: *d');
      expect(out).not.toBeNull();
      expect(decode(out!)).toEqual({ defaults: { timeout: 30 }, a: { timeout: 30 }, b: { timeout: 30 } });
    });

    it('rejects circular anchors with a 400 instead of a 500', () => {
      expect(() => processor.process('a: &a\n  self: *a')).toThrow(/circular references/);
    });
  });

  describe('64 KB byte cap', () => {
    it('rejects an object payload whose serialized JSON exceeds 64 KB', () => {
      const input: CloudInit = { runcmd: [`echo ${'a'.repeat(70_000)}`] };
      expect(() => processor.process(input)).toThrow(/must not exceed 64 KB/);
    });

    it('rejects a YAML string whose parsed payload exceeds 64 KB', () => {
      const input = `runcmd:\n  - echo ${'a'.repeat(70_000)}`;
      expect(() => processor.process(input)).toThrow(/must not exceed 64 KB/);
    });
  });
});
