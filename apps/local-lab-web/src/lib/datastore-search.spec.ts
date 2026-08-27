import { describe, expect, it } from 'vitest';

import { TABS } from '@/features/datastore/datastore-page';

import type { DatastoreSearch } from './datastore-search';
import { deviceQueuesSearch, isDatastoreTab, toDatastoreTab, validateDatastoreSearch } from './datastore-search';

const defaults: DatastoreSearch = {
  tab: 'pg',
  schema: undefined,
  table: undefined,
  page: undefined,
  tableFilter: undefined,
  key: undefined,
  match: undefined,
  metric: undefined,
  metricFilter: undefined,
  queuePrefix: undefined,
  queueName: undefined,
  queueFilter: undefined,
  jobState: undefined,
  jobId: undefined,
  deviceId: undefined,
};

describe('validateDatastoreSearch', () => {
  it('lands on the postgres tab with no selection when the url carries nothing', () => {
    expect(validateDatastoreSearch({})).toEqual(defaults);
  });

  it('drops wrong-typed params back to the defaults instead of throwing', () => {
    expect(
      validateDatastoreSearch({
        schema: 1,
        table: true,
        page: 'two',
        tableFilter: 3,
        key: {},
        match: null,
        metric: [],
        metricFilter: false,
        queuePrefix: 5,
        queueName: {},
        queueFilter: null,
        jobState: 'retrying',
        jobId: [],
        deviceId: true,
      }),
    ).toEqual(defaults);
  });

  it('treats empty strings as absent', () => {
    expect(
      validateDatastoreSearch({
        table: '',
        match: '',
        metricFilter: '',
        queuePrefix: '',
        queueName: '',
        queueFilter: '',
        jobState: '',
        jobId: '',
        deviceId: '',
      }),
    ).toEqual(defaults);
  });

  it('keeps only a job state the queue contract carries', () => {
    expect(validateDatastoreSearch({ jobState: 'failed' }).jobState).toBe('failed');
    expect(validateDatastoreSearch({ jobState: 'delayed' }).jobState).toBe('delayed');
    expect(validateDatastoreSearch({ jobState: 'waiting-children' }).jobState).toBe('waiting-children');
    expect(validateDatastoreSearch({ jobState: 'stalled' }).jobState).toBeUndefined();
    expect(validateDatastoreSearch({ jobState: 'unknown' }).jobState).toBeUndefined();
  });

  it('accepts only a non-negative integer page', () => {
    expect(validateDatastoreSearch({ page: 0 }).page).toBe(0);
    expect(validateDatastoreSearch({ page: 4 }).page).toBe(4);
    expect(validateDatastoreSearch({ page: -1 }).page).toBeUndefined();
    expect(validateDatastoreSearch({ page: 1.5 }).page).toBeUndefined();
    expect(validateDatastoreSearch({ page: Number.POSITIVE_INFINITY }).page).toBeUndefined();
    expect(validateDatastoreSearch({ page: Number.NaN }).page).toBeUndefined();
  });

  it('degrades an unknown tab to postgres', () => {
    expect(validateDatastoreSearch({ tab: 'sagas' }).tab).toBe('pg');
    expect(validateDatastoreSearch({ tab: 7 }).tab).toBe('pg');
    expect(validateDatastoreSearch({ tab: undefined }).tab).toBe('pg');
  });

  it('round-trips a fully specified view', () => {
    const search: DatastoreSearch = {
      tab: 'redis',
      schema: 'public',
      table: 'Device',
      page: 3,
      tableFilter: 'dev',
      key: 'zone:1:prefix:2:config:dhcp',
      match: '*:device:*',
      metric: 'up',
      metricFilter: 'node',
      queuePrefix: '11111111-2222-3333-4444-555555555555',
      queueName: 'lifecycle',
      queueFilter: 'inbox',
      jobState: 'failed',
      jobId: '66666666-7777-8888-9999-000000000000-provision',
      deviceId: '66666666-7777-8888-9999-000000000000',
    };
    expect(validateDatastoreSearch({ ...search })).toEqual(search);
  });

  it('ignores params the route does not own', () => {
    expect(validateDatastoreSearch({ tab: 'thanos', bogus: 'x' })).toEqual({ ...defaults, tab: 'thanos' });
  });
});

describe('deviceQueuesSearch', () => {
  const DEVICE = '00000000-0000-0000-0000-000000000007';

  it('supplies every param even when the current url carries none', () => {
    expect(deviceQueuesSearch({}, DEVICE)).toEqual({ ...defaults, tab: 'queues', deviceId: DEVICE });
  });

  it('keeps the queue and job selection the operator already had', () => {
    expect(
      deviceQueuesSearch({ tab: 'pg', queuePrefix: 'zone-a', queueName: 'lifecycle', jobId: 'job-1', page: 2 }, DEVICE),
    ).toEqual({
      ...defaults,
      tab: 'queues',
      queuePrefix: 'zone-a',
      queueName: 'lifecycle',
      jobId: 'job-1',
      page: 2,
      deviceId: DEVICE,
    });
  });

  it('replaces a device scope from an earlier deep-link', () => {
    expect(deviceQueuesSearch({ deviceId: 'other' }, DEVICE).deviceId).toBe(DEVICE);
  });

  it('leaves the job state filter unset', () => {
    expect(deviceQueuesSearch({}, DEVICE).jobState).toBeUndefined();
  });
});

describe('toDatastoreTab', () => {
  it('keeps each known tab id', () => {
    expect(toDatastoreTab('pg')).toBe('pg');
    expect(toDatastoreTab('redis')).toBe('redis');
    expect(toDatastoreTab('thanos')).toBe('thanos');
    expect(toDatastoreTab('queues')).toBe('queues');
  });

  it('degrades an id the union does not carry', () => {
    expect(toDatastoreTab('sagas')).toBe('pg');
  });
});

describe('isDatastoreTab', () => {
  it('accepts the union members and rejects everything else', () => {
    expect(isDatastoreTab('pg')).toBe(true);
    expect(isDatastoreTab('redis')).toBe(true);
    expect(isDatastoreTab('thanos')).toBe(true);
    expect(isDatastoreTab('queues')).toBe(true);
    expect(isDatastoreTab('sagas')).toBe(false);
    expect(isDatastoreTab('')).toBe(false);
    expect(isDatastoreTab(undefined)).toBe(false);
    expect(isDatastoreTab(7)).toBe(false);
  });
});

describe('the datastore route tab bar', () => {
  it('renders only ids the union carries', () => {
    for (const tab of TABS) {
      expect(isDatastoreTab(tab.id)).toBe(true);
      expect(toDatastoreTab(tab.id)).toBe(tab.id);
    }
  });

  it('renders a tab for every union member', () => {
    expect(TABS.map((tab) => tab.id).sort()).toEqual(['pg', 'queues', 'redis', 'thanos']);
  });
});
