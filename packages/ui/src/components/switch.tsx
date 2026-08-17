import { Switch as BaseSwitch } from '@base-ui/react/switch';
import * as React from 'react';

import { cn } from './utils';

const Switch = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof BaseSwitch.Root>>(
  ({ className, ...props }, ref) => (
    <BaseSwitch.Root
      className={cn(
        'peer inline-flex h-[24px] w-[44px] shrink-0 cursor-pointer items-center rounded-full',
        'border-2 border-transparent transition-colors',
        'bg-border',
        'data-[checked]:bg-accent',
        'focus-visible:ring-accent focus-visible:ring-offset-bg-primary focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
      ref={ref}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0 transition-transform',
          'bg-bg-primary',
          'data-[checked]:translate-x-5 data-[unchecked]:translate-x-0',
        )}
      />
    </BaseSwitch.Root>
  ),
);
Switch.displayName = 'Switch';

export { Switch };
