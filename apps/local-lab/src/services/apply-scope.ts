export const CONTROL_NAMESPACE = 'control';

export type ApplyScope =
  | { kind: 'all' }
  | { kind: 'namespaces'; namespaces: readonly string[] }
  | { kind: 'processes'; names: readonly string[] };

export const APPLY_SCOPE_ALL: ApplyScope = { kind: 'all' };

export const applyScopeNamespaces = (...namespaces: string[]): ApplyScope => ({ kind: 'namespaces', namespaces });

export const applyScopeProcesses = (names: Iterable<string>): ApplyScope => ({ kind: 'processes', names: [...names] });

/** The control namespace (lab, lab-web) is held out of every scope here rather than at each call
 *  site: recreating the control center would kill the request driving the apply. */
export function inApplyScope(scope: ApplyScope, name: string, namespace: string): boolean {
  if (namespace === CONTROL_NAMESPACE) return false;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'namespaces') return scope.namespaces.includes(namespace);
  return scope.names.includes(name);
}

export function describeApplyScope(scope: ApplyScope): string {
  if (scope.kind === 'all') return 'every namespace but control';
  if (scope.kind === 'namespaces') return `namespace{${scope.namespaces.join(', ')}}`;
  return `{${scope.names.join(', ')}}`;
}
