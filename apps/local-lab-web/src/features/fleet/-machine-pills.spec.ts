import { describe, expect, it } from 'vitest';

import { bmcPill, hubPill } from './machine-pills';

const ONLINE = 'text-status-online/90';
const WARNING = 'text-status-warning/90';

describe('bmcPill', () => {
  it('names the BMC power state when the probe is ok', () => {
    expect(bmcPill({ reachable: 'ok', powerState: 'On' })).toEqual({ value: 'On', tone: ONLINE });
  });

  it('falls back to ok when a reachable probe reports no power state', () => {
    expect(bmcPill({ reachable: 'ok', powerState: null })).toEqual({ value: 'ok', tone: ONLINE });
  });

  it('names the failure when the probe did not answer', () => {
    expect(bmcPill({ reachable: 'unreachable', powerState: null })).toEqual({ value: 'unreachable', tone: WARNING });
  });

  it('reads n/a for a row with no probe', () => {
    expect(bmcPill(null)).toEqual({ value: 'n/a', tone: WARNING });
  });
});

describe('hubPill', () => {
  it('names the hub device the row resolved to', () => {
    expect(hubPill('dev-1')).toEqual({ value: 'dev-1', tone: ONLINE });
  });

  it('reads no device when the row resolved to none', () => {
    expect(hubPill(null)).toEqual({ value: 'no device', tone: WARNING });
  });

  it('reads split when the PXE MAC and the BMC sit on two hub devices', () => {
    expect(hubPill('dev-1', true)).toEqual({ value: 'split', tone: WARNING });
  });
});
