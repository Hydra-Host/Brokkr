import { DiscoveryIssuePhase, DiscoveryIssueSeverity, DiscoveryRunStatus } from '@repo/database/enums';
import { describe, expect, it } from 'vitest';
import { DiscoveryIssuePhaseSchema, DiscoveryIssueSeveritySchema, DiscoveryRunStatusSchema } from '../discovery-runs';

describe('DiscoveryRunStatusSchema', () => {
  it('derives its options from the prisma DiscoveryRunStatus enum', () => {
    expect(DiscoveryRunStatusSchema.options).toEqual(Object.values(DiscoveryRunStatus));
  });

  it('accepts a known status', () => {
    expect(DiscoveryRunStatusSchema.parse('PARTIAL')).toBe('PARTIAL');
  });

  it('rejects a status outside the enum', () => {
    expect(DiscoveryRunStatusSchema.safeParse('RUNNING').success).toBe(false);
  });
});

describe('DiscoveryIssuePhaseSchema', () => {
  it('derives its options from the prisma DiscoveryIssuePhase enum', () => {
    expect(DiscoveryIssuePhaseSchema.options).toEqual(Object.values(DiscoveryIssuePhase));
  });

  it('accepts a known phase', () => {
    expect(DiscoveryIssuePhaseSchema.parse('COMPOSER')).toBe('COMPOSER');
  });

  it('rejects a phase outside the enum', () => {
    expect(DiscoveryIssuePhaseSchema.safeParse('DRAIN').success).toBe(false);
  });
});

describe('DiscoveryIssueSeveritySchema', () => {
  it('derives its options from the prisma DiscoveryIssueSeverity enum', () => {
    expect(DiscoveryIssueSeveritySchema.options).toEqual(Object.values(DiscoveryIssueSeverity));
  });

  it('accepts a known severity', () => {
    expect(DiscoveryIssueSeveritySchema.parse('WARN')).toBe('WARN');
  });

  it('rejects a severity outside the enum', () => {
    expect(DiscoveryIssueSeveritySchema.safeParse('FATAL').success).toBe(false);
  });
});
