import { describe, expect, it } from 'vitest';

import { FleetHealthSchema, InitTaskSchema, ProcHealthSchema } from '@/contract';

import { FLEET_HEALTH_UI, HEALTH_UI, healthUi, RUNNING_HEALTH, serviceHealthUi, UP_NO_PROBE } from './health-ui';

const notes = (): Record<string, string> =>
  Object.fromEntries(Object.entries(HEALTH_UI).map(([key, ui]) => [key, ui.note]));

describe('HEALTH_UI notes', () => {
  it('pins every note string', () => {
    expect(notes()).toEqual({
      up: 'ready',
      [UP_NO_PROBE]: 'up · no probe',
      unhealthy: 'starting',
      crashlooping: 'crash-looping',
      failed: 'failed',
      blocked: 'blocked',
      down: 'stopped',
      disabled: 'disabled',
      missing: 'no process',
      running: 'running',
      completed: 'done',
      cached: 'cached',
      pending: 'not run',
    });
  });

  it('covers every ProcHealth the server can send', () => {
    for (const health of ProcHealthSchema.options) expect(HEALTH_UI[health]).toBeDefined();
  });

  it('covers every InitTask state the server can send', () => {
    for (const state of InitTaskSchema.shape.state.options) expect(HEALTH_UI[state]).toBeDefined();
  });

  it('falls back to the raw status for an unmapped one', () => {
    expect(healthUi('not-a-health').note).toBe('not-a-health');
  });

  it('keeps RUNNING_HEALTH to ProcHealth values — the probe-less variant is web-only', () => {
    expect(RUNNING_HEALTH).toEqual(['up', 'unhealthy', 'crashlooping']);
    expect(RUNNING_HEALTH).not.toContain(UP_NO_PROBE);
    for (const health of RUNNING_HEALTH) expect(ProcHealthSchema.options).toContain(health);
  });
});

describe('serviceHealthUi', () => {
  it('reads ready for a running process whose probe passed', () => {
    expect(serviceHealthUi({ health: 'up', ready: true }).note).toBe('ready');
  });

  it('says up · no probe rather than ready for a running process with no probe', () => {
    expect(serviceHealthUi({ health: 'up', ready: false }).note).toBe('up · no probe');
  });

  it('leaves every non-up health alone', () => {
    expect(serviceHealthUi({ health: 'failed', ready: false }).note).toBe('failed');
    expect(serviceHealthUi({ health: 'disabled', ready: false }).note).toBe('disabled');
    expect(serviceHealthUi({ health: 'missing', ready: false }).note).toBe('no process');
  });
});

describe('FLEET_HEALTH_UI notes', () => {
  it('pins every note string', () => {
    expect(Object.fromEntries(Object.entries(FLEET_HEALTH_UI).map(([key, ui]) => [key, ui.note]))).toEqual({
      ready: 'ready',
      degraded: 'degraded',
      'coming-up': 'coming up',
      stopped: 'stopped',
      failed: 'failed',
      disabled: 'disabled',
      idle: 'not started',
    });
  });

  it('covers every FleetHealth the contract declares', () => {
    for (const health of FleetHealthSchema.options) expect(FLEET_HEALTH_UI[health]).toBeDefined();
  });
});
