import { useLayoutEffect, useRef, type RefObject } from 'react';

const CONSOLE_FILL_VARIABLE = '--console-fill';

export interface FillMetrics {
  parentTop: number;
  parentClientHeight: number;
  parentScrollTop: number;
  parentPaddingBottom: number;
  wrapperTop: number;
  wrapperBottom: number;
  contentBottom: number;
}

/** The wrapper height at which the scroll parent's content exactly fits its client box. */
export function consoleFillHeight(metrics: FillMetrics): number {
  const above = metrics.wrapperTop - metrics.parentTop + metrics.parentScrollTop;
  const below = metrics.contentBottom + metrics.parentPaddingBottom - metrics.wrapperBottom;
  return Math.max(0, metrics.parentClientHeight - above - below);
}

function findScrollParent(element: HTMLElement): HTMLElement {
  let candidate = element.parentElement;
  while (candidate !== null && candidate !== document.documentElement) {
    const { overflowY } = getComputedStyle(candidate);
    if (overflowY === 'auto' || overflowY === 'scroll') return candidate;
    candidate = candidate.parentElement;
  }
  return document.documentElement;
}

// scrollHeight never drops below clientHeight, so it cannot tell a short page from one that exactly fits
function contentBottomOf(parent: HTMLElement): number {
  return Math.max(...Array.from(parent.children, (child) => child.getBoundingClientRect().bottom));
}

export function useFillScrollParent(ref: RefObject<HTMLElement | null>): void {
  const appliedRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const wrapper = ref.current;
    if (wrapper === null) return;
    const parent = findScrollParent(wrapper);

    const measure = () => {
      const parentRect = parent.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      const height = consoleFillHeight({
        parentTop: parentRect.top,
        parentClientHeight: parent.clientHeight,
        parentScrollTop: parent.scrollTop,
        parentPaddingBottom: Number.parseFloat(getComputedStyle(parent).paddingBottom),
        wrapperTop: wrapperRect.top,
        wrapperBottom: wrapperRect.bottom,
        contentBottom: contentBottomOf(parent),
      });
      // sub-pixel jitter from fractional rects must not re-set the variable and re-trigger the observer
      if (appliedRef.current !== null && Math.abs(height - appliedRef.current) <= 1) return;
      appliedRef.current = height;
      wrapper.style.setProperty(CONSOLE_FILL_VARIABLE, `${height}px`);
    };

    measure();
    // jsdom and SSR have no ResizeObserver; the wrapper's min-height floor is the fallback
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (wrapper.parentElement !== null) observer.observe(wrapper.parentElement);
    return () => observer.disconnect();
  }, [ref]);
}
