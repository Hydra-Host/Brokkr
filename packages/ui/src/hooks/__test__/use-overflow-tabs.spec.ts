import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeVisibleCount, useOverflowTabs } from '../use-overflow-tabs';

describe('computeVisibleCount', () => {
  it.each([
    {
      name: 'returns every tab when the row fits',
      widths: [50, 50, 50],
      available: 200,
      gap: 16,
      reserve: 112,
      expected: 3,
    },
    { name: 'counts the gaps between tabs', widths: [50, 50, 50], available: 182, gap: 16, reserve: 112, expected: 3 },
    {
      name: 'holds the reserve once a tab overflows',
      widths: [50, 50, 50],
      available: 181,
      gap: 16,
      reserve: 112,
      expected: 1,
    },
    {
      name: 'returns none when the first tab exceeds the budget',
      widths: [200, 200],
      available: 150,
      gap: 16,
      reserve: 112,
      expected: 0,
    },
    {
      name: 'keeps the largest prefix beside the reserve',
      widths: [100, 100, 100, 100],
      available: 350,
      gap: 16,
      reserve: 112,
      expected: 2,
    },
    {
      name: 'applies the given gap to the prefix',
      widths: [100, 100, 100],
      available: 339,
      gap: 20,
      reserve: 100,
      expected: 2,
    },
    { name: 'returns zero for no tabs', widths: [], available: 100, gap: 16, reserve: 112, expected: 0 },
  ])('$name', ({ widths, available, gap, reserve, expected }) => {
    expect(computeVisibleCount(widths, available, gap, reserve)).toBe(expected);
  });
});

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  fire(): void {
    this.callback([], this);
  }
}

function Harness({ widths, containerWidth }: { widths: number[]; containerWidth: number }) {
  const { containerRef, setItemRef, visibleCount, measured } = useOverflowTabs({ itemCount: widths.length });
  return createElement(
    'div',
    {
      ref: containerRef,
      'data-testid': 'container',
      'data-cw': containerWidth,
      'data-visible': visibleCount,
      'data-measured': String(measured),
    },
    widths.map((width, index) => createElement('span', { key: index, ref: setItemRef(index), 'data-w': width })),
  );
}

const widthGetter = (attribute: 'w' | 'cw') =>
  function (this: HTMLElement) {
    return Number(this.dataset[attribute] ?? 0);
  };

describe('useOverflowTabs', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: widthGetter('w') });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: widthGetter('cw') });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows every tab and reports unmeasured when ResizeObserver is undefined', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { getByTestId } = render(createElement(Harness, { widths: [100, 100, 100, 100], containerWidth: 100 }));
    expect(getByTestId('container').dataset.visible).toBe('4');
    expect(getByTestId('container').dataset.measured).toBe('false');
  });

  it('measures on mount and observes the container', () => {
    const { getByTestId } = render(createElement(Harness, { widths: [100, 100, 100, 100], containerWidth: 400 }));
    const container = getByTestId('container');
    expect(container.dataset.visible).toBe('2');
    expect(container.dataset.measured).toBe('true');
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]!.observe).toHaveBeenCalledWith(container);
  });

  it('re-measures when the container resizes', () => {
    const { getByTestId } = render(createElement(Harness, { widths: [100, 100, 100, 100], containerWidth: 400 }));
    const container = getByTestId('container');
    container.dataset.cw = '600';
    act(() => FakeResizeObserver.instances[0]!.fire());
    expect(container.dataset.visible).toBe('4');
    container.dataset.cw = '200';
    act(() => FakeResizeObserver.instances[0]!.fire());
    expect(container.dataset.visible).toBe('0');
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(createElement(Harness, { widths: [100], containerWidth: 400 }));
    unmount();
    expect(FakeResizeObserver.instances[0]!.disconnect).toHaveBeenCalled();
  });
});
