import type { LoadingStep } from './linux-panel-types';
import type { BrokkrCommandHandler } from './use-linux-vm';
import { useLinuxVM } from './use-linux-vm';

// Tiny local class joiner so the plugin has no UI-library dependency.
function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

interface TerminalWindowProps {
  className?: string;
  onCommand?: BrokkrCommandHandler;
  getBashCompletion?: () => Promise<string>;
}

function StepIcon({ status }: { status: LoadingStep['status'] }) {
  switch (status) {
    case 'pending':
      return <div className="border-border-dim h-3 w-3 border" />;
    case 'active':
      return <div className="animate-border-chase border-border-dim h-3 w-3 border-2" />;
    case 'done':
      return (
        <div className="bg-status-online flex h-3 w-3 items-center justify-center">
          <svg className="text-bg-primary h-2 w-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      );
    case 'error':
      return (
        <div className="bg-status-offline flex h-3 w-3 items-center justify-center">
          <svg className="text-bg-primary h-2 w-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      );
  }
}

function LoadingOverlay({ loadingSteps, progress }: { loadingSteps: LoadingStep[]; progress: number }) {
  return (
    <div className="text-text-muted flex h-full flex-col items-center justify-center gap-4 px-8">
      <div className="w-full max-w-xs">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span>Initializing Linux VM</span>
          <span className="font-mono">{progress}%</span>
        </div>
        <div className="bg-bg-secondary h-2 w-full overflow-hidden">
          <div className="bg-accent h-full transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="w-full max-w-xs space-y-1.5">
        {loadingSteps.map((step) => (
          <div key={step.id} className="flex items-center gap-2 text-xs">
            <StepIcon status={step.status} />
            <span
              className={cx(
                step.status === 'done' && 'text-text-dim',
                step.status === 'active' && 'text-text-primary',
                step.status === 'pending' && 'text-text-dim',
                step.status === 'error' && 'text-status-offline',
              )}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorOverlay({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="text-text-muted flex h-full flex-col items-center justify-center gap-4">
      <div className="text-center">
        <h3 className="text-status-offline mb-2 text-lg font-medium">Failed to Start</h3>
        <p className="text-text-dim mb-4 max-w-sm text-sm">{message}</p>
        <button
          onClick={onRetry}
          className="border-accent text-accent hover:bg-active-bg border bg-transparent px-4 py-2 text-sm font-medium"
        >
          Try Again
        </button>
      </div>
      <div className="text-text-dim mt-4 max-w-md space-y-1 text-center text-xs">
        <p>Common issues:</p>
        <p>- Browser must support SharedArrayBuffer (requires HTTPS)</p>
        <p>- WebVM disk server may be temporarily unavailable</p>
        <p>- Ad blockers may interfere with loading</p>
      </div>
    </div>
  );
}

function IdleOverlay() {
  const isCrossOriginIsolated = typeof self !== 'undefined' && self.crossOriginIsolated;

  if (isCrossOriginIsolated) {
    return (
      <div className="text-text-muted flex h-full flex-col items-center justify-center gap-4">
        <div className="animate-border-chase border-border-dim h-5 w-5 border-2" />
        <span className="text-sm">Starting Linux VM...</span>
      </div>
    );
  }

  return (
    <div className="text-text-muted flex h-full flex-col items-center justify-center gap-4">
      <div className="text-center">
        <h3 className="text-text-primary mb-2 text-lg font-medium">Linux Terminal</h3>
        <div className="border-status-warning/30 bg-status-warning/10 text-status-warning mx-auto mb-4 max-w-sm border px-3 py-2 text-xs">
          <strong>Cross-origin isolation not enabled.</strong>
          <br />
          This page did not receive COOP/COEP headers from the server.
        </div>
      </div>
    </div>
  );
}

export function TerminalWindow({ className, onCommand, getBashCompletion }: TerminalWindowProps) {
  const { containerRef, loadingState, errorMessage, loadingSteps, progress, retry } = useLinuxVM({
    onCommand,
    getBashCompletion,
  });

  return (
    <div className={cx('bg-bg-primary relative h-full w-full p-3', className)}>
      <div
        ref={containerRef}
        className={cx(
          'h-full w-full overflow-hidden',
          '[&_.xterm]:h-full [&_.xterm-screen]:h-full [&_.xterm-viewport]:h-full',
        )}
      />
      {loadingState !== 'ready' && (
        <div className="bg-bg-primary absolute inset-0">
          {loadingState === 'idle' && <IdleOverlay />}
          {(loadingState === 'loading-script' || loadingState === 'loading-vm') && (
            <LoadingOverlay loadingSteps={loadingSteps} progress={progress} />
          )}
          {loadingState === 'error' && <ErrorOverlay message={errorMessage} onRetry={retry} />}
        </div>
      )}
    </div>
  );
}

export default TerminalWindow;
