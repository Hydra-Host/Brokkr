import { type ReactNode } from 'react';

import { errorMessage } from '@/lib/errors';

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="border-status-offline/30 bg-status-offline/10 text-status-offline rounded-md border px-3 py-2 font-mono text-xs">
      {children}
    </div>
  );
}

export function errText(data: { status: number; body: unknown } | undefined, thrown: unknown): string | null {
  if (data && data.status !== 200) return errorMessage(data);
  return errorMessage(thrown);
}
