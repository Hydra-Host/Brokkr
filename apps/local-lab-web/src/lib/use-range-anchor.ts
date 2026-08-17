import { useEffect, useState } from 'react';

export type RangeAnchor = { metric: string; nowMs: number };

export function useRangeAnchor(metric: string | null, advanceMs: number): RangeAnchor | null {
  const [anchor, setAnchor] = useState<RangeAnchor | null>(null);

  useEffect(() => {
    if (!metric) {
      setAnchor(null);
      return;
    }
    const advance = () => setAnchor({ metric, nowMs: Date.now() });
    advance();
    const id = setInterval(advance, advanceMs);
    return () => clearInterval(id);
  }, [metric, advanceMs]);

  // withheld until the anchor matches the caller's metric, so the render that switches selection
  // yields null instead of the previous selection's window (callers key a query off this)
  return anchor && anchor.metric === metric ? anchor : null;
}
