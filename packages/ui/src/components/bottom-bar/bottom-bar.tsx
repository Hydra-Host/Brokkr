import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../utils';
import { ApiPanel } from './api-panel';
import { useApiMonitor } from './use-api-monitor';

const MIN_PANEL_HEIGHT = 150;
const MAX_PANEL_HEIGHT_RATIO = 0.8;

interface BottomBarProps {
  className?: string;
}

export function BottomBar({ className }: BottomBarProps) {
  const { calls } = useApiMonitor();
  const [isExpanded, setIsExpanded] = useState(false);

  const [panelHeight, setPanelHeight] = useState(() => Math.round(window.innerHeight * 0.5));
  const isResizingRef = useRef(false);

  const [lastSeenCount, setLastSeenCount] = useState(0);
  const newCallsCount = calls.length - lastSeenCount;

  const toggle = useCallback(() => {
    setIsExpanded((prev) => {
      const willExpand = !prev;
      if (willExpand) {
        setLastSeenCount(calls.length);
      }
      return willExpand;
    });
  }, [calls.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [toggle]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      const startY = e.clientY;
      const startHeight = panelHeight;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizingRef.current) return;
        const delta = startY - moveEvent.clientY;
        const maxHeight = Math.round(window.innerHeight * MAX_PANEL_HEIGHT_RATIO);
        const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, startHeight + delta));
        setPanelHeight(newHeight);
      };

      const handleMouseUp = () => {
        isResizingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [panelHeight],
  );

  return (
    <div
      className={cn(
        'border-sidebar-border bg-bg-primary fixed right-0 bottom-0 z-10 flex flex-col border-t font-mono text-sm transition-[left] duration-200 ease-linear will-change-[left]',
        'left-0 md:left-[var(--sidebar-width)] md:peer-data-[collapsible=icon]:left-[var(--sidebar-width-icon)]',
        className,
      )}
    >
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div onMouseDown={handleResizeStart} className="group/resize relative h-1 cursor-row-resize">
            <div className="bg-accent absolute inset-x-0 top-0 h-[2px] opacity-0 transition-opacity group-hover/resize:opacity-100" />
          </div>
          <div className="border-sidebar-border border-b" style={{ height: panelHeight }}>
            <ApiPanel />
          </div>
        </div>
      </div>

      <div className="relative flex h-12 shrink-0 items-center px-4">
        <div className="flex shrink-0 gap-1">
          <button
            onClick={toggle}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 text-xs transition-colors',
              isExpanded ? 'bg-active-bg text-accent' : 'text-text-dim hover:text-text-primary',
            )}
          >
            API
            {newCallsCount > 0 && (
              <span className="bg-status-offline text-foreground px-1.5 text-[10px] font-medium">{newCallsCount}</span>
            )}
          </button>
        </div>

        <div className="flex-1" />
        <div className="text-text-dim hidden shrink-0 items-center gap-2 text-xs sm:flex">
          <kbd className="border-sidebar-border bg-bg-secondary border px-1.5 py-0.5">Ctrl+`</kbd>
          <span>toggle</span>
        </div>

        <button
          onClick={toggle}
          className="text-text-dim hover:text-text-primary ml-2 p-1"
          aria-label={isExpanded ? 'Collapse panel' : 'Expand panel'}
        >
          <svg
            className={cn('h-4 w-4 transition-transform duration-200', isExpanded ? 'rotate-0' : 'rotate-180')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default BottomBar;
