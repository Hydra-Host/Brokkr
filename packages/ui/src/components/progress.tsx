import { Progress as BaseProgress } from '@base-ui/react/progress';
import * as React from 'react';

import { cn } from './utils';

interface ProgressProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseProgress.Root>, 'value'> {
  value?: number;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(({ className, value, ...props }, ref) => (
  <BaseProgress.Root ref={ref} value={value ?? null} className={cn('relative', className)} {...props}>
    <BaseProgress.Track className="bg-bg-secondary relative h-4 w-full overflow-hidden rounded-full">
      <BaseProgress.Indicator
        className="bg-accent h-full w-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </BaseProgress.Track>
  </BaseProgress.Root>
));
Progress.displayName = 'Progress';

export { Progress };
