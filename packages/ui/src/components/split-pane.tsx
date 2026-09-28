import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { cn } from './utils';

export type SplitPaneStackBreakpoint = 'sm' | 'md' | 'lg' | 'xl';

export interface SplitPaneProps {
  primary: ReactNode;
  secondary: ReactNode;
  defaultPrimaryWidth?: number;
  minPrimaryWidth?: number;
  maxPrimaryWidth?: number;
  /** Below this breakpoint the panes stack and the handle is hidden. */
  stackBelow?: SplitPaneStackBreakpoint;
  onPrimaryWidthChange?: (width: number) => void;
  handleLabel?: string;
  className?: string;
}

const KEYBOARD_STEP_PX = 16;

// tailwind only sees literal class strings, so each breakpoint spells out its own variants
const STACK_CLASSES: Record<SplitPaneStackBreakpoint, { root: string; primary: string; handle: string }> = {
  sm: {
    root: 'sm:flex-row sm:gap-0',
    primary: 'sm:w-(--split-pane-primary-width) sm:shrink-0',
    handle: 'sm:block',
  },
  md: {
    root: 'md:flex-row md:gap-0',
    primary: 'md:w-(--split-pane-primary-width) md:shrink-0',
    handle: 'md:block',
  },
  lg: {
    root: 'lg:flex-row lg:gap-0',
    primary: 'lg:w-(--split-pane-primary-width) lg:shrink-0',
    handle: 'lg:block',
  },
  xl: {
    root: 'xl:flex-row xl:gap-0',
    primary: 'xl:w-(--split-pane-primary-width) xl:shrink-0',
    handle: 'xl:block',
  },
};

function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)));
}

// jsdom has no pointer capture; a missing method must not break the drag
function capturePointer(target: HTMLElement, pointerId: number): void {
  if (typeof target.setPointerCapture === 'function') target.setPointerCapture(pointerId);
}

function releasePointer(target: HTMLElement, pointerId: number): void {
  if (typeof target.releasePointerCapture === 'function' && target.hasPointerCapture(pointerId)) {
    target.releasePointerCapture(pointerId);
  }
}

interface DragStart {
  startX: number;
  startWidth: number;
}

export function SplitPane({
  primary,
  secondary,
  defaultPrimaryWidth = 320,
  minPrimaryWidth = 160,
  maxPrimaryWidth = 560,
  stackBelow = 'lg',
  onPrimaryWidthChange,
  handleLabel = 'Resize panes',
  className,
}: SplitPaneProps) {
  const [width, setWidth] = useState(() => clampWidth(defaultPrimaryWidth, minPrimaryWidth, maxPrimaryWidth));
  const dragRef = useRef<DragStart | null>(null);
  const stack = STACK_CLASSES[stackBelow];

  // Unmount mid-drag detaches the pointer handlers, so endDrag never runs.
  useEffect(
    () => () => {
      if (!dragRef.current) return;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  const applyWidth = (next: number) => {
    const clamped = clampWidth(next, minPrimaryWidth, maxPrimaryWidth);
    if (clamped === width) return;
    setWidth(clamped);
    onPrimaryWidthChange?.(clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    capturePointer(event.currentTarget, event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    applyWidth(drag.startWidth + (event.clientX - drag.startX));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowLeft':
        applyWidth(width - KEYBOARD_STEP_PX);
        break;
      case 'ArrowRight':
        applyWidth(width + KEYBOARD_STEP_PX);
        break;
      case 'Home':
        applyWidth(minPrimaryWidth);
        break;
      case 'End':
        applyWidth(maxPrimaryWidth);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const style: CSSProperties & { '--split-pane-primary-width': string } = {
    '--split-pane-primary-width': `${width}px`,
  };

  return (
    <div className={cn('flex flex-col gap-6', stack.root, className)} style={style}>
      <div className={cn('w-full min-w-0', stack.primary)}>{primary}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={handleLabel}
        aria-valuemin={minPrimaryWidth}
        aria-valuemax={maxPrimaryWidth}
        aria-valuenow={width}
        tabIndex={0}
        className={cn(
          'bg-border hover:bg-primary/50 focus-visible:bg-primary mx-2 hidden w-1 shrink-0 cursor-col-resize touch-none self-stretch rounded-full transition-colors focus-visible:outline-none',
          stack.handle,
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
      <div className="min-w-0 flex-1">{secondary}</div>
    </div>
  );
}
