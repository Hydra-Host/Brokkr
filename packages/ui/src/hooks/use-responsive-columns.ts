import { useEffect, useState } from 'react';

import type { VisibilityState } from '@tanstack/react-table';

type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const BREAKPOINT_ORDER: Breakpoint[] = ['mobile', 'tablet', 'desktop'];

function getBreakpoint(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop';
  if (window.innerWidth < 768) return 'mobile';
  if (window.innerWidth < 1024) return 'tablet';
  return 'desktop';
}

function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState(getBreakpoint);

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 767px)');
    const tabletQuery = window.matchMedia('(min-width: 768px) and (max-width: 1023px)');

    const update = () => setBreakpoint(getBreakpoint());

    mobileQuery.addEventListener('change', update);
    tabletQuery.addEventListener('change', update);
    return () => {
      mobileQuery.removeEventListener('change', update);
      tabletQuery.removeEventListener('change', update);
    };
  }, []);

  return breakpoint;
}

export function useResponsiveColumns(config: Record<string, Breakpoint>, expanded = false): VisibilityState {
  const breakpoint = useBreakpoint();
  const breakpointIndex = BREAKPOINT_ORDER.indexOf(breakpoint);

  const visibility: VisibilityState = {};
  for (const [columnId, minBreakpoint] of Object.entries(config)) {
    if (expanded) {
      visibility[columnId] = true;
    } else {
      const minIndex = BREAKPOINT_ORDER.indexOf(minBreakpoint);
      visibility[columnId] = breakpointIndex >= minIndex;
    }
  }
  return visibility;
}
