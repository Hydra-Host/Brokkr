export interface ActiveRecordContext {
  organizationId: string;
  /** Effective permission keys (`resource:action`) for policy `actions` gating; absent is fail-closed (every gated action denied). */
  permissions?: ReadonlySet<string>;
  system?: boolean;
  /** Audit sink for every gated policy action, fired before the allow/deny decision and before the `system` short-circuit.
   *  Optional so this package stays free of any host-app dependency. */
  onPermissionCheck?: (permissionKey: string, denied: boolean) => void;
}

export type ContextProvider = () => ActiveRecordContext | undefined;
