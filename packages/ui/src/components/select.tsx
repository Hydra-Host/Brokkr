import { Select as BaseSelect } from '@base-ui/react/select';
import clsx from 'clsx';
import { Check, ChevronDown, InfoIcon } from 'lucide-react';
import * as React from 'react';

import { Label } from './label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { cn } from './utils';

interface SelectWrapperProps {
  children: React.ReactNode;
  label?: string;
  tooltip?: string;
  error?: string;
  className?: string;
  id?: string;
}

const SelectWrapper: React.FC<SelectWrapperProps> = ({ children, label, tooltip, error, className, id }) => {
  return (
    <div className={clsx('flex w-full flex-col gap-2', className)}>
      {label && (
        <div className="flex h-6 items-center gap-2">
          <Label htmlFor={id}>{label}</Label>
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
      {children}
      {error && <Label className="text-status-offline normal-case">{error}</Label>}
    </div>
  );
};

interface SelectRootProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseSelect.Root>, 'onValueChange'> {
  onValueChange?: (value: string) => void;
}

const Select: React.FC<SelectRootProps> = ({ onValueChange, ...props }) => {
  const handleValueChange = React.useCallback(
    (value: unknown) => {
      if (onValueChange && value !== null && typeof value === 'string') {
        onValueChange(value);
      }
    },
    [onValueChange],
  );

  return <BaseSelect.Root onValueChange={handleValueChange} {...props} />;
};
Select.displayName = 'Select';

const SelectGroup = BaseSelect.Group;

const SelectValue = BaseSelect.Value;

interface SelectTriggerProps extends React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger> {
  error?: string;
  hideCorners?: boolean;
}

const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, children, error, hideCorners, ...props }, ref) => (
    <BaseSelect.Trigger
      ref={ref}
      aria-invalid={error ? true : undefined}
      className={cn(
        'group flex h-10 w-full items-center justify-between gap-x-1 px-3 py-2 font-mono text-sm',
        'bg-bg-primary text-text-primary',
        'border-text-muted border-t border-r-0 border-b border-l-0',
        'focus:border-accent focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[placeholder]:text-text-dim',
        '[&>span]:line-clamp-1',
        'relative',
        error ? 'border-status-offline focus:border-status-offline' : '',
        className,
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon>
        <ChevronDown className="text-text-muted h-4 w-4" />
      </BaseSelect.Icon>
      {!hideCorners && (
        <>
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -top-px -left-px h-2 w-2 border-t border-l group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -top-px -right-px h-2 w-2 border-t border-r group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -bottom-px -left-px h-2 w-2 border-b border-l group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -right-px -bottom-px h-2 w-2 border-r border-b group-disabled:opacity-50" />
        </>
      )}
    </BaseSelect.Trigger>
  ),
);
SelectTrigger.displayName = 'SelectTrigger';

const SelectScrollUpButton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex cursor-default items-center justify-center py-1', className)} {...props}>
      <ChevronDown className="h-4 w-4 rotate-180" />
    </div>
  ),
);
SelectScrollUpButton.displayName = 'SelectScrollUpButton';

const SelectScrollDownButton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex cursor-default items-center justify-center py-1', className)} {...props}>
      <ChevronDown className="h-4 w-4" />
    </div>
  ),
);
SelectScrollDownButton.displayName = 'SelectScrollDownButton';

interface SelectContentProps extends React.ComponentPropsWithoutRef<typeof BaseSelect.Popup> {
  position?: 'popper' | 'item-aligned';
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

const SelectContent = React.forwardRef<HTMLDivElement, SelectContentProps>(
  ({ className, children, position = 'popper', side = 'bottom', align = 'start', ...props }, ref) => (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        sideOffset={4}
        side={side}
        align={align}
        alignItemWithTrigger={false}
        className="!z-[9999] w-[var(--anchor-width)]"
        style={{ zIndex: 9999 }}
      >
        <BaseSelect.Popup
          ref={ref}
          className={cn(
            'relative z-[9999] min-w-32 rounded-sm',
            'bg-bg-secondary text-text-primary border-border border font-mono shadow-md',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
            'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
            className,
          )}
          style={{ zIndex: 9999 }}
          {...props}
        >
          <div className="max-h-72 overflow-y-auto p-1">{children}</div>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  ),
);
SelectContent.displayName = 'SelectContent';

const SelectLabel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('text-accent py-1.5 pr-2 pl-8 font-mono text-xs font-bold tracking-wide uppercase', className)}
      {...props}
    />
  ),
);
SelectLabel.displayName = 'SelectLabel';

const SelectItem = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseSelect.Item>>(
  ({ className, children, ...props }, ref) => (
    <BaseSelect.Item
      ref={ref}
      className={cn(
        'relative flex w-full cursor-pointer items-center rounded-sm py-1.5 pr-2 pl-8 font-mono text-sm',
        'outline-none select-none',
        'hover:bg-accent/10 hover:text-text-primary',
        'focus:bg-accent/10 focus:text-text-primary',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <BaseSelect.ItemIndicator>
          <Check className="text-accent h-4 w-4" />
        </BaseSelect.ItemIndicator>
      </span>
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  ),
);
SelectItem.displayName = 'SelectItem';

const SelectSeparator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />,
);
SelectSeparator.displayName = 'SelectSeparator';

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SelectWrapper,
};
