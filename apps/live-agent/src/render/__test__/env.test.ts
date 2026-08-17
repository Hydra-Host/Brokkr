import { describe, expect, it } from 'vitest';
import { makeRenderEnv, renderEnv, stripTrailingNewline } from '../env';
import { HYDRA_ROCE_QOS_SERVICE } from '../roce/index';
import metaDataTemplate from '../templates/cloud-init-meta-data.njk';

describe('renderEnv', () => {
  it('renders a simple template string with substitution', () => {
    const out = renderEnv.renderString('hello {{ name }}', { name: 'world' });
    expect(out).toBe('hello world');
  });

  it('throws on undefined variables', () => {
    expect(() => renderEnv.renderString('hi {{ missing }}', {})).toThrow();
  });

  it('does not autoescape HTML special chars', () => {
    const out = renderEnv.renderString('{{ s }}', { s: '<a>&"' });
    expect(out).toBe('<a>&"');
  });

  it('strips the newline after each block tag (trimBlocks=true)', () => {
    const out = renderEnv.renderString('{% if true %}\nx\n{% endif %}\n', {});
    expect(out).toBe('x\n');
  });

  it('strips leading whitespace before a block tag (lstripBlocks=true)', () => {
    const out = renderEnv.renderString('  {% if true %}x{% endif %}', {});
    expect(out).toBe('x');
  });
});

describe('startswith filter', () => {
  it('returns true when string starts with prefix', () => {
    const out = renderEnv.renderString('{{ s | startswith("ttyS") }}', { s: 'ttyS1' });
    expect(out).toBe('true');
  });

  it('returns false when string does not start with prefix', () => {
    const out = renderEnv.renderString('{{ s | startswith("ttyS") }}', { s: 'console' });
    expect(out).toBe('false');
  });

  it('treats null and undefined inputs as empty string', () => {
    const out = renderEnv.renderString('{{ s | startswith("x") }}', { s: null });
    expect(out).toBe('false');
  });

  it('is registered on every env constructed via makeRenderEnv', () => {
    const fresh = makeRenderEnv();
    const out = fresh.renderString('{{ s | startswith("a") }}', { s: 'abc' });
    expect(out).toBe('true');
  });
});

describe('stripTrailingNewline', () => {
  it('removes exactly one trailing newline', () => {
    expect(stripTrailingNewline('foo\n')).toBe('foo');
  });

  it('only removes one newline when multiple are present', () => {
    expect(stripTrailingNewline('foo\n\n')).toBe('foo\n');
  });

  it('returns input unchanged when there is no trailing newline', () => {
    expect(stripTrailingNewline('foo')).toBe('foo');
  });

  it('handles empty string', () => {
    expect(stripTrailingNewline('')).toBe('');
  });
});

describe('text-asset loader (.njk imports)', () => {
  it('inlines cloud-init-meta-data.njk content as a string', () => {
    expect(metaDataTemplate).toBe('instance-id: {{ device_id }}\n');
  });
});

describe('text-asset loader (.service imports via index re-export)', () => {
  it('inlines hydra-roce-qos.service content as a string', () => {
    expect(HYDRA_ROCE_QOS_SERVICE).toContain('[Unit]');
    expect(HYDRA_ROCE_QOS_SERVICE).toContain('Configure RoCE QoS');
    expect(HYDRA_ROCE_QOS_SERVICE).toContain('[Install]');
  });
});
