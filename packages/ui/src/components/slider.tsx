import { Slider as BaseSlider } from '@base-ui/react/slider';
import * as React from 'react';

import { cn } from './utils';

interface SliderProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseSlider.Root>, 'children'> {
  className?: string;
}

const Slider = React.forwardRef<HTMLDivElement, SliderProps>(({ className, ...props }, ref) => (
  <BaseSlider.Root
    ref={ref}
    className={cn('relative flex w-full touch-none items-center select-none', className)}
    {...props}
  >
    <BaseSlider.Control className="flex w-full items-center">
      <BaseSlider.Track className="bg-bg-secondary relative h-2 w-full grow overflow-hidden rounded-full">
        <BaseSlider.Indicator className="bg-accent absolute h-full" />
      </BaseSlider.Track>
      <BaseSlider.Thumb
        className={cn(
          'border-accent bg-bg-primary block h-5 w-5 rounded-full border-2 transition-colors',
          'focus-visible:ring-accent focus-visible:ring-offset-bg-primary focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      />
    </BaseSlider.Control>
  </BaseSlider.Root>
));
Slider.displayName = 'Slider';

export { Slider };
