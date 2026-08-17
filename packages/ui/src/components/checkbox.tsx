import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import clsx from 'clsx';
import { Check, InfoIcon } from 'lucide-react';
import * as React from 'react';

import { Label } from './label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { cn } from './utils';

interface CheckboxProps
  extends Omit<React.ComponentPropsWithoutRef<typeof BaseCheckbox.Root>, 'checked' | 'onCheckedChange'> {
  label?: string;
  tooltip?: string;
  tooltipDelay?: number;
  error?: string;
  labelClassName?: string;
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      className,
      label,
      tooltip,
      tooltipDelay,
      error,
      labelClassName,
      checked,
      defaultChecked,
      onCheckedChange,
      ...props
    },
    ref,
  ) => {
    const id = props.id || props.name;

    const isIndeterminate = checked === 'indeterminate';
    const checkedValue = isIndeterminate ? false : checked;

    const handleCheckedChange = React.useCallback(
      (newChecked: boolean) => {
        if (onCheckedChange) {
          onCheckedChange(newChecked);
        }
      },
      [onCheckedChange],
    );

    return (
      <div className={clsx('flex flex-col gap-2', className)}>
        <div className="flex items-center gap-2">
          <div className="flex items-center space-x-2">
            <BaseCheckbox.Root
              ref={ref}
              id={id}
              checked={checkedValue}
              defaultChecked={defaultChecked}
              onCheckedChange={handleCheckedChange}
              indeterminate={isIndeterminate}
              className={cn(
                'peer border-accent h-4 w-4 shrink-0 rounded-sm border',
                'bg-transparent',
                'focus-visible:ring-accent focus-visible:ring-offset-bg-primary focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'data-[checked]:bg-accent data-[checked]:text-primary-foreground',
                error ? 'border-status-offline focus-visible:ring-status-offline' : '',
              )}
              {...props}
            >
              <BaseCheckbox.Indicator className={cn('flex items-center justify-center text-current')}>
                <Check className="h-3 w-3" strokeWidth={3} />
              </BaseCheckbox.Indicator>
            </BaseCheckbox.Root>
            {label && (
              <Label htmlFor={id} className={cn('text-text-primary text-sm normal-case', labelClassName)}>
                {label}
              </Label>
            )}
          </div>
          {tooltip && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger delay={tooltipDelay}>
                  <InfoIcon className="text-text-dim h-4 w-4 cursor-help" />
                </TooltipTrigger>
                <TooltipContent>{tooltip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {error && <Label className="text-status-offline normal-case">{error}</Label>}
      </div>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
