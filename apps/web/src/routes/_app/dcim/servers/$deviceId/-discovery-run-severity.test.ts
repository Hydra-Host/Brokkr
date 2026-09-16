import { describe, expect, it } from 'vitest';
import { worstSeverity } from './-discovery-run-severity';

const at = (...severities: Array<'INFO' | 'WARN' | 'ERROR'>) => severities.map((severity) => ({ severity }));

describe('worstSeverity', () => {
  it('returns null for a run with no issues', () => {
    expect(worstSeverity([])).toBeNull();
  });

  it('returns the only severity present', () => {
    expect(worstSeverity(at('INFO'))).toBe('INFO');
  });

  it('picks WARN over an earlier INFO', () => {
    expect(worstSeverity(at('INFO', 'WARN'))).toBe('WARN');
  });

  it('picks ERROR over an earlier WARN', () => {
    expect(worstSeverity(at('WARN', 'ERROR'))).toBe('ERROR');
  });

  it('picks ERROR wherever it sits in the list', () => {
    expect(worstSeverity(at('ERROR', 'INFO'))).toBe('ERROR');
    expect(worstSeverity(at('INFO', 'ERROR', 'WARN'))).toBe('ERROR');
  });

  it('does not degrade to the first entry when no ERROR is present', () => {
    expect(worstSeverity(at('INFO', 'INFO', 'WARN'))).toBe('WARN');
  });
});
