import { cn } from '@repo/ui/utils';
import { Info, TriangleAlert } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

interface CalloutProps {
  title?: string;
  children: ReactNode;
}

// Trailing ! beats the equal-specificity [&_p] typography in -docs-page.tsx Content.
const CONTENT_OVERRIDES =
  '[&_p]:mb-2! [&_p]:text-sm! [&_p]:leading-relaxed! [&_p]:tracking-normal! [&_p:last-child]:mb-0!';

interface ToneCalloutProps extends CalloutProps {
  icon: ComponentType<{ className?: string }>;
  tone: string;
  iconTone: string;
  title: string;
}

function Callout({ icon: Icon, tone, iconTone, title, children }: ToneCalloutProps) {
  return (
    <aside role="note" className={cn('my-8 flex gap-3 rounded-lg border p-4', tone)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconTone)} aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-foreground mb-1 text-sm font-semibold">{title}</div>
        <div className={CONTENT_OVERRIDES}>{children}</div>
      </div>
    </aside>
  );
}

export function Note({ title = 'Note', children }: CalloutProps) {
  return (
    <Callout icon={Info} tone="border-primary/30 bg-primary/5" iconTone="text-primary" title={title}>
      {children}
    </Callout>
  );
}

export function Warning({ title = 'Warning', children }: CalloutProps) {
  return (
    <Callout
      icon={TriangleAlert}
      tone="border-status-warning/40 bg-status-warning/10"
      iconTone="text-status-warning"
      title={title}
    >
      {children}
    </Callout>
  );
}
