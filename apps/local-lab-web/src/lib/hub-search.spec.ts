import { describe, expect, it } from 'vitest';

import { TABS } from '@/routes/hub';

import { deviceTokensSearch, isHubTab, jobLifecycleSearch, toHubTab, validateHubSearch } from './hub-search';

const EMPTY = {
  tab: 'lifecycle',
  deliveryStatus: undefined,
  webhookId: undefined,
  phases: [],
  jobId: undefined,
  deviceId: undefined,
  tokenStatus: undefined,
  tokenId: undefined,
};

describe('validateHubSearch', () => {
  it('defaults to the lifecycle tab, which is the flow most often debugged', () => {
    expect(validateHubSearch({})).toEqual(EMPTY);
  });

  it('falls back to lifecycle for an unknown tab rather than throwing', () => {
    expect(validateHubSearch({ tab: 'nope' }).tab).toBe('lifecycle');
  });

  it('drops a phase outside the engine vocabulary instead of passing it to the api', () => {
    expect(validateHubSearch({ phases: 'IN_PROGRESS' }).phases).toEqual([]);
    expect(validateHubSearch({ phases: 'AWAITING_PHONE_HOME' }).phases).toEqual(['AWAITING_PHONE_HOME']);
  });

  it('reads a whole phase group from one param, in either shape the router may hand it', () => {
    expect(validateHubSearch({ phases: 'RUNNING,FAILED' }).phases).toEqual(['RUNNING', 'FAILED']);
    expect(validateHubSearch({ phases: ['RUNNING', 'FAILED'] }).phases).toEqual(['RUNNING', 'FAILED']);
  });

  it('keeps the known phases of a partly bogus list rather than dropping the whole filter', () => {
    expect(validateHubSearch({ phases: 'RUNNING,NONSENSE' }).phases).toEqual(['RUNNING']);
  });

  it('drops a delivery status and token status outside their vocabularies', () => {
    expect(validateHubSearch({ deliveryStatus: 'EXPLODED' }).deliveryStatus).toBeUndefined();
    expect(validateHubSearch({ tokenStatus: 'MAYBE' }).tokenStatus).toBeUndefined();
    expect(validateHubSearch({ deliveryStatus: 'FAILED', tokenStatus: 'REVOKED' })).toMatchObject({
      deliveryStatus: 'FAILED',
      tokenStatus: 'REVOKED',
    });
  });

  it('treats an empty string as absent so a cleared filter leaves the url', () => {
    expect(validateHubSearch({ deviceId: '' }).deviceId).toBeUndefined();
  });

  it('drops params it does not own', () => {
    expect(validateHubSearch({ tab: 'tokens', nonsense: 'x' })).toEqual({ ...EMPTY, tab: 'tokens' });
  });
});

describe('deep-link reducers', () => {
  it('lands on the lifecycle tab scoped to one job', () => {
    expect(jobLifecycleSearch({}, 'plan-1')).toMatchObject({ tab: 'lifecycle', jobId: 'plan-1' });
  });

  it('lands on the tokens tab scoped to one device', () => {
    expect(deviceTokensSearch({}, 'dev-1')).toMatchObject({ tab: 'tokens', deviceId: 'dev-1' });
  });

  it('keeps unrelated params the operator already had', () => {
    const prior = { ...EMPTY, tab: 'webhooks' as const, deliveryStatus: 'FAILED' as const };

    expect(jobLifecycleSearch(prior, 'plan-1')).toEqual({
      ...prior,
      tab: 'lifecycle',
      jobId: 'plan-1',
    });
  });

  it('clears a previously selected token when scoping to a different device', () => {
    const prior = { ...EMPTY, tab: 'tokens' as const, tokenId: 'tok-old', deviceId: 'dev-old' };

    expect(deviceTokensSearch(prior, 'dev-new')).toMatchObject({ deviceId: 'dev-new', tokenId: undefined });
  });

  it('clears the phase filter, so a job deep link cannot land on a list that hides its own job', () => {
    expect(jobLifecycleSearch({ phases: 'FAILED' }, 'plan-1').phases).toEqual([]);
  });
});

describe('the hub route tab bar', () => {
  it('renders only ids the union carries', () => {
    for (const tab of TABS) {
      expect(isHubTab(tab.id)).toBe(true);
      expect(toHubTab(tab.id)).toBe(tab.id);
    }
  });

  it('renders a tab for every union member', () => {
    expect(TABS.map((tab) => tab.id).sort()).toEqual(['lifecycle', 'tokens', 'webhooks']);
  });
});

describe('the tokens deep link', () => {
  it('clears a status filter the operator already had, so a device link shows every token it has', () => {
    const prior = { ...EMPTY, tab: 'tokens' as const, tokenStatus: 'REVOKED' as const };

    expect(deviceTokensSearch(prior, 'dev-1')).toMatchObject({ deviceId: 'dev-1', tokenStatus: undefined });
  });
});
