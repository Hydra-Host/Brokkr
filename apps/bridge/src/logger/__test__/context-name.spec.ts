import { describe, expect, it } from 'vitest';

import {
  extractCoreName,
  extractRouteName,
  extractServiceName,
  extractStartupName,
  getContextName,
} from '../context/context-name';

describe('getContextName — top-level dispatch', () => {
  it('returns "unknown" for the logger module itself (skip-self)', () => {
    expect(getContextName('bridge.core.logging')).toBe('unknown');
  });

  it('returns "unknown" when no rule matches', () => {
    expect(getContextName('foo.bar.baz')).toBe('unknown');
  });

  it('routes module → "routes-<leaf>"', () => {
    expect(getContextName('bridge.routes.sync')).toBe('routes-sync');
    expect(getContextName('bridge.routes.ipxe')).toBe('routes-ipxe');
  });

  it('services module → "service-<first segment after services>"', () => {
    expect(getContextName('bridge.services.foo.bar')).toBe('service-foo');
    expect(getContextName('bridge.services.deployment')).toBe('service-deployment');
  });

  it('startup module → bare "<first segment after startup>"', () => {
    expect(getContextName('bridge.startup.boot_grpc')).toBe('boot_grpc');
  });

  it('brokkr_bridge_api suffix → "bridge-api"', () => {
    expect(getContextName('brokkr_bridge_api')).toBe('bridge-api');
    expect(getContextName('some.pkg.brokkr_bridge_api')).toBe('bridge-api');
  });

  it('main module → "orchestrator"', () => {
    expect(getContextName('bridge.main')).toBe('orchestrator');
    expect(getContextName('__main__')).toBe('orchestrator');
  });

  it('substring trap: "main" anywhere → "orchestrator"', () => {
    expect(getContextName('some.domain.foo')).toBe('orchestrator');
    expect(getContextName('app.remaining')).toBe('orchestrator');
  });

  it('tftpy module → "tftp"', () => {
    expect(getContextName('tftpy.server')).toBe('tftp');
  });

  it('tftp (case-insensitive) → "tftp"', () => {
    expect(getContextName('bridge.adapters.TFTP')).toBe('tftp');
    expect(getContextName('bridge.adapters.tftp')).toBe('tftp');
  });

  it('core module → "core-<first segment after core>"', () => {
    expect(getContextName('bridge.core.cache')).toBe('core-cache');
    expect(getContextName('bridge.core.auth')).toBe('core-auth');
  });

  it('routes takes precedence over later rules', () => {
    expect(getContextName('bridge.routes.services')).toBe('routes-services');
  });

  it('services takes precedence over startup/core/main', () => {
    expect(getContextName('bridge.services.startup_helper')).toBe('service-startup_helper');
  });

  it('startup takes precedence over main/core', () => {
    expect(getContextName('bridge.startup.maincore')).toBe('maincore');
  });
});

describe('extractRouteName', () => {
  it('returns "routes-<leaf>" for valid routes path', () => {
    expect(extractRouteName('bridge.routes.sync')).toBe('routes-sync');
  });

  it('returns "routes-<leaf>" using the LAST segment, not the first after "routes"', () => {
    expect(extractRouteName('bridge.routes.a.b.c')).toBe('routes-c');
  });

  it('falls back to "routes" when split has fewer than 3 parts', () => {
    expect(extractRouteName('routes.foo')).toBe('routes');
  });

  it('falls back to "routes" when "routes" is a substring but not a discrete part', () => {
    expect(extractRouteName('bridge.myroutes.foo')).toBe('routes');
  });
});

describe('extractServiceName', () => {
  it('returns "service-<first after services>"', () => {
    expect(extractServiceName('bridge.services.foo.bar.baz')).toBe('service-foo');
  });

  it('falls back to "service" when no next segment after "services"', () => {
    expect(extractServiceName('bridge.services')).toBe('service');
  });

  it('falls back to "service" when "services" is only a substring of a part', () => {
    expect(extractServiceName('bridge.myservices.foo')).toBe('service');
  });
});

describe('extractStartupName', () => {
  it('returns bare first segment after "startup"', () => {
    expect(extractStartupName('bridge.startup.boot_grpc')).toBe('boot_grpc');
  });

  it('falls back to "startup" when no next segment', () => {
    expect(extractStartupName('bridge.startup')).toBe('startup');
  });

  it('falls back to "startup" when "startup" is only a substring of a part', () => {
    expect(extractStartupName('bridge.mystartup.foo')).toBe('startup');
  });
});

describe('extractCoreName', () => {
  it('returns "core-<first after core>"', () => {
    expect(extractCoreName('bridge.core.cache')).toBe('core-cache');
  });

  it('falls back to "core" when no next segment', () => {
    expect(extractCoreName('bridge.core')).toBe('core');
  });

  it('falls back to "core" when "core" is only a substring of a part', () => {
    expect(extractCoreName('bridge.mycore.foo')).toBe('core');
  });
});
