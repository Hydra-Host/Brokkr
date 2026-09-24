import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface OverflowTabsOptions {
  itemCount: number;
  /** Horizontal gap between tabs; matches the tablist's `gap-4`. */
  gapPx?: number;
  /** Width held for the More trigger and its rule when some tabs overflow. */
  reservePx?: number;
  /** Width of the bracket decorations around the tablist. */
  chromePx?: number;
}

export interface OverflowTabs {
  containerRef: RefObject<HTMLDivElement | null>;
  setItemRef: (index: number) => (element: HTMLElement | null) => void;
  /** Equals `itemCount` until the first measurement. */
  visibleCount: number;
  measured: boolean;
}

export function computeVisibleCount(
  itemWidths: readonly number[],
  availablePx: number,
  gapPx: number,
  reservePx: number,
): number {
  let total = 0;
  itemWidths.forEach((width, index) => {
    total += width + (index > 0 ? gapPx : 0);
  });
  if (total <= availablePx) return itemWidths.length;

  const budget = availablePx - reservePx;
  let used = 0;
  let count = 0;
  for (const width of itemWidths) {
    const next = used + (count > 0 ? gapPx : 0) + width;
    if (next > budget) break;
    used = next;
    count += 1;
  }
  return count;
}

interface MeasureState {
  visibleCount: number;
  measured: boolean;
}

export function useOverflowTabs({
  itemCount,
  gapPx = 16,
  reservePx = 112,
  chromePx = 48,
}: OverflowTabsOptions): OverflowTabs {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const [state, setState] = useState<MeasureState>({ visibleCount: itemCount, measured: false });

  const setItemRef = useCallback(
    (index: number) => (element: HTMLElement | null) => {
      itemRefs.current[index] = element;
    },
    [],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    // jsdom and SSR have no ResizeObserver; leaving every tab visible is the safe fallback
    if (container === null || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const widths = itemRefs.current.slice(0, itemCount).map((element) => element?.offsetWidth ?? 0);
      const visibleCount = computeVisibleCount(widths, container.clientWidth - chromePx, gapPx, reservePx);
      setState((previous) =>
        previous.measured && previous.visibleCount === visibleCount ? previous : { visibleCount, measured: true },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [itemCount, gapPx, reservePx, chromePx]);

  return {
    containerRef,
    setItemRef,
    visibleCount: state.measured ? state.visibleCount : itemCount,
    measured: state.measured,
  };
}
