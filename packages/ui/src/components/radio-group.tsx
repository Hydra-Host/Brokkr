import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Circle } from 'lucide-react';
import * as React from 'react';

import { cn } from './utils';

const RadioGroup = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseRadioGroup>>(
  ({ className, ...props }, ref) => {
    return <BaseRadioGroup className={cn('grid gap-2', className)} {...props} ref={ref} />;
  },
);
RadioGroup.displayName = 'RadioGroup';

const RadioGroupItem = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof BaseRadio.Root>>(
  ({ className, ...props }, ref) => {
    return (
      <BaseRadio.Root
        ref={ref}
        className={cn(
          'border-accent aspect-square h-4 w-4 rounded-full border',
          'text-accent',
          'focus-visible:ring-accent focus-visible:ring-offset-bg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <BaseRadio.Indicator className="flex items-center justify-center">
          <Circle className="h-2.5 w-2.5 fill-current text-current" />
        </BaseRadio.Indicator>
      </BaseRadio.Root>
    );
  },
);
RadioGroupItem.displayName = 'RadioGroupItem';

export { RadioGroup, RadioGroupItem };
