declare module './events' {
  interface BrokkrEventMap {
    'bridge.leadership.changed': { instanceId: string; isLeader: boolean };
    'bridge.saga.step.completed': { sagaName: string; stepName: string; planId: string };
    'bridge.saga.completed': { sagaName: string; planId: string };
    'bridge.saga.failed': { sagaName: string; planId: string; error: string | null };
  }
}

export {};
