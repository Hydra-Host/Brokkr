import clsx from 'clsx';
import { InfoIcon } from 'lucide-react';
import * as React from 'react';

import { Label } from './label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { cn } from './utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  tooltip?: string;
  error?: string;
  labelClassName?: string;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, tooltip, error, labelClassName, ...props }, ref) => {
    const id = props.id || props.name;

    return (
      <div className={clsx('flex w-full flex-col gap-2', className)}>
        {label && (
          <div className="flex h-6 items-center gap-2">
            <Label htmlFor={id} className={labelClassName}>
              {label}
            </Label>
            {tooltip && (
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="text-text-dim h-4 w-4 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[250px]">
                    <p>{tooltip}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        )}
        <div className="relative">
          <textarea
            id={id}
            aria-invalid={error ? true : undefined}
            className={cn(
              'peer flex min-h-[80px] w-full px-3 py-2 font-mono text-sm',
              'bg-bg-primary text-text-primary',
              'border-text-muted border-t border-r-0 border-b border-l-0',
              'placeholder:text-text-dim',
              'focus:border-accent focus:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              error ? 'border-status-offline focus:border-status-offline' : '',
            )}
            ref={ref}
            {...props}
          />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute top-0 left-0 h-2 w-2 border-t border-l peer-disabled:opacity-50" />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute top-0 right-0 h-2 w-2 border-t border-r peer-disabled:opacity-50" />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute bottom-0 left-0 h-2 w-2 border-b border-l peer-disabled:opacity-50" />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute right-0 bottom-0 h-2 w-2 border-r border-b peer-disabled:opacity-50" />
        </div>
        {error && <Label className="text-status-offline normal-case">{error}</Label>}
      </div>
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
