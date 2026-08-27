import { describe, expect, it } from 'vitest';

import {
  APPLY_SCOPE_ALL,
  applyScopeNamespaces,
  applyScopeProcesses,
  CONTROL_NAMESPACE,
  describeApplyScope,
  inApplyScope,
} from '../apply-scope';

describe('inApplyScope', () => {
  it('holds the control namespace out of the all scope', () => {
    expect(inApplyScope(APPLY_SCOPE_ALL, 'hub-api', 'hub')).toBe(true);
    expect(inApplyScope(APPLY_SCOPE_ALL, 'lab', CONTROL_NAMESPACE)).toBe(false);
    expect(inApplyScope(APPLY_SCOPE_ALL, 'lab-web', CONTROL_NAMESPACE)).toBe(false);
  });

  it('holds the control namespace out of a namespace scope that names it', () => {
    const scope = applyScopeNamespaces('hub', CONTROL_NAMESPACE);
    expect(inApplyScope(scope, 'hub-api', 'hub')).toBe(true);
    expect(inApplyScope(scope, 'lab', CONTROL_NAMESPACE)).toBe(false);
  });

  it('holds the control namespace out of a process scope that names the process', () => {
    const scope = applyScopeProcesses(['spoke', 'lab', 'lab-web']);
    expect(inApplyScope(scope, 'spoke', 'spoke')).toBe(true);
    expect(inApplyScope(scope, 'lab', CONTROL_NAMESPACE)).toBe(false);
    expect(inApplyScope(scope, 'lab-web', CONTROL_NAMESPACE)).toBe(false);
  });

  it('matches a namespace scope on the namespace and a process scope on the name', () => {
    const byNamespace = applyScopeNamespaces('hub');
    expect(inApplyScope(byNamespace, 'hub-api', 'hub')).toBe(true);
    expect(inApplyScope(byNamespace, 'spoke', 'spoke')).toBe(false);

    const byProcess = applyScopeProcesses(['hub-api']);
    expect(inApplyScope(byProcess, 'hub-api', 'hub')).toBe(true);
    expect(inApplyScope(byProcess, 'hub-admin', 'hub')).toBe(false);
  });

  it('keeps an unnamespaced process out of a namespace scope', () => {
    expect(inApplyScope(applyScopeNamespaces('hub'), 'stray', '')).toBe(false);
    expect(inApplyScope(APPLY_SCOPE_ALL, 'stray', '')).toBe(true);
  });

  it('copies the names a process scope is built from', () => {
    const names = ['spoke', 'fleet'];
    const scope = applyScopeProcesses(names);
    names.push('lab');
    expect(inApplyScope(scope, 'lab', 'control-plane')).toBe(false);
  });
});

describe('describeApplyScope', () => {
  it('names what each scope covers', () => {
    expect(describeApplyScope(APPLY_SCOPE_ALL)).toBe('every namespace but control');
    expect(describeApplyScope(applyScopeNamespaces('hub', 'spoke'))).toBe('namespace{hub, spoke}');
    expect(describeApplyScope(applyScopeProcesses(['spoke', 'fleet']))).toBe('{spoke, fleet}');
  });
});
