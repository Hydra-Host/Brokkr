import { describe, expect, it } from 'vitest';

import { capabilityRefusalMessage, isCapabilityRefusal, LAB_CAPABILITIES } from './capability';

describe('capabilityRefusalMessage', () => {
  it('is the wire text the lab refuses with', () => {
    expect(capabilityRefusalMessage('host-exec')).toBe(
      "this lab route requires the 'host-exec' capability: present a token that carries it",
    );
  });

  it('names the capability it was asked about', () => {
    expect(capabilityRefusalMessage('admin')).toContain("'admin'");
  });
});

describe('isCapabilityRefusal', () => {
  it('matches the message the lab composes for that capability', () => {
    expect(isCapabilityRefusal(capabilityRefusalMessage('host-exec'), 'host-exec')).toBe(true);
  });

  it('does not match a refusal naming a different capability', () => {
    expect(isCapabilityRefusal(capabilityRefusalMessage('admin'), 'host-exec')).toBe(false);
  });

  it('does not match an unrelated failure', () => {
    expect(isCapabilityRefusal('sudo password rejected', 'host-exec')).toBe(false);
    expect(isCapabilityRefusal('', 'host-exec')).toBe(false);
  });
});

describe('LAB_CAPABILITIES', () => {
  it('is ordered weakest to strongest', () => {
    expect(LAB_CAPABILITIES).toEqual(['read', 'operate', 'admin', 'host-exec']);
  });
});
