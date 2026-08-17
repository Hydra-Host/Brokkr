import { useCallback, useEffect, useRef, useState } from 'react';

import { tsr } from '@/lib/api';

export const RUN_POLL_INTERVAL_MS = 1500;
// measures silence, not run duration: a lost run (api restarted mid-run) stops reporting and would
// otherwise pin busy forever, while a long op that keeps reporting running must never be cut loose.
export const RUN_WEDGE_TIMEOUT_MS = 90_000;

type RunTrackerOptions = {
  // keeps busy when the run reaches a terminal status; the wedge timeout is then the only release.
  holdOnTerminal?: boolean;
  onTerminal?: () => void;
};

export function useRunTracker({ holdOnTerminal = false, onTerminal }: RunTrackerOptions = {}) {
  const [runId, setRunId] = useState<string | null>(null);
  const wedgeRef = useRef<number | null>(null);
  // callers pass an inline closure, so keeping it out of the effect deps is what stops an unrelated
  // re-render from re-running the effect and extending the wedge.
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;
  const armedForRef = useRef(0);

  const run = tsr.getRun.useQuery({
    queryKey: ['run', runId],
    queryData: { params: { runId: runId ?? '' } },
    refetchInterval: RUN_POLL_INTERVAL_MS,
    enabled: runId !== null,
    retry: false,
  });

  const clearWedge = useCallback(() => {
    if (wedgeRef.current !== null) {
      clearTimeout(wedgeRef.current);
      wedgeRef.current = null;
    }
  }, []);

  const armWedge = useCallback(() => {
    clearWedge();
    wedgeRef.current = window.setTimeout(() => {
      setRunId(null);
      wedgeRef.current = null;
    }, RUN_WEDGE_TIMEOUT_MS);
  }, [clearWedge]);

  useEffect(() => {
    if (runId === null || run.data?.status !== 200 || run.data.body.runId !== runId) return;
    if (run.data.body.status === 'running') {
      // one extension per poll response: the budget measures reporting silence, not wall time
      if (run.dataUpdatedAt !== armedForRef.current) {
        armedForRef.current = run.dataUpdatedAt;
        armWedge();
      }
      return;
    }
    if (holdOnTerminal) return;
    clearWedge();
    setRunId(null);
    onTerminalRef.current?.();
  }, [run.data, run.dataUpdatedAt, runId, holdOnTerminal, armWedge, clearWedge]);

  useEffect(() => clearWedge, [clearWedge]);

  const track = useCallback(
    (id: string) => {
      setRunId(id);
      armedForRef.current = 0;
      armWedge();
    },
    [armWedge],
  );

  return { active: runId !== null, track };
}
