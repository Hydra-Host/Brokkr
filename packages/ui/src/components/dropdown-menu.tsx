import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import * as React from 'react';

import { cn } from './utils';

const DropdownMenu = BaseMenu.Root;

interface DropdownMenuTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseMenu.Trigger>, 'render'> {
  asChild?: boolean;
}

const DropdownMenuTrigger = React.forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  ({ asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return <BaseMenu.Trigger ref={ref} render={children} {...props} />;
    }
    return (
      <BaseMenu.Trigger ref={ref} {...props}>
        {children}
      </BaseMenu.Trigger>
    );
  },
);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

const DropdownMenuGroup = BaseMenu.Group;

const DropdownMenuPortal = BaseMenu.Portal;

const DropdownMenuSub = BaseMenu.Root;

const DropdownMenuRadioGroup = BaseMenu.RadioGroup;

const DropdownMenuSubTrigger = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseMenu.SubmenuTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, ...props }, ref) => (
  <BaseMenu.SubmenuTrigger
    ref={ref}
    className={cn(
      'flex cursor-pointer items-center rounded-sm px-2 py-1.5 font-mono text-sm outline-none select-none',
      'focus:bg-accent/10 focus:text-text-primary',
      'data-[state=open]:bg-accent/10 data-[state=open]:text-text-primary',
      inset && 'pl-8',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto h-4 w-4" />
  </BaseMenu.SubmenuTrigger>
));
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

const DropdownMenuSubContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseMenu.Popup>>(
  ({ className, ...props }, ref) => (
    <BaseMenu.Positioner className="!z-[9999]" style={{ zIndex: 9999 }}>
      <BaseMenu.Popup
        ref={ref}
        className={cn(
          'z-[9999] min-w-32 overflow-hidden rounded-sm p-1',
          'bg-bg-secondary text-text-primary border-border border font-mono shadow-lg',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        style={{ zIndex: 9999 }}
        {...props}
      />
    </BaseMenu.Positioner>
  ),
);
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';

interface DropdownMenuContentProps extends React.ComponentPropsWithoutRef<typeof BaseMenu.Popup> {
  sideOffset?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  ({ className, sideOffset = 4, side, align, ...props }, ref) => (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        sideOffset={sideOffset}
        side={side}
        align={align}
        className="!z-[9999]"
        style={{ zIndex: 9999 }}
      >
        <BaseMenu.Popup
          ref={ref}
          className={cn(
            'z-[9999] min-w-32 overflow-hidden rounded-sm p-1',
            'bg-bg-secondary text-text-primary border-border border font-mono shadow-md',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
            'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className,
          )}
          style={{ zIndex: 9999 }}
          {...props}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  ),
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

interface DropdownMenuItemProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseMenu.Item>, 'render'> {
  inset?: boolean;
  asChild?: boolean;
}

const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className, inset, asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      return (
        <BaseMenu.Item
          ref={ref}
          className={cn(
            'relative flex cursor-pointer items-center rounded-sm px-2 py-1.5 font-mono text-sm transition-colors outline-none select-none',
            'focus:bg-accent/10 focus:text-text-primary',
            'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
            inset && 'pl-8',
            className,
          )}
          render={children}
          {...props}
        />
      );
    }
    return (
      <BaseMenu.Item
        ref={ref}
        className={cn(
          'relative flex cursor-pointer items-center rounded-sm px-2 py-1.5 font-mono text-sm transition-colors outline-none select-none',
          'focus:bg-accent/10 focus:text-text-primary',
          'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
          inset && 'pl-8',
          className,
        )}
        {...props}
      >
        {children}
      </BaseMenu.Item>
    );
  },
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuCheckboxItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseMenu.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <BaseMenu.CheckboxItem
    ref={ref}
    className={cn(
      'relative flex cursor-pointer items-center rounded-sm py-1.5 pr-2 pl-8 font-mono text-sm transition-colors outline-none select-none',
      'focus:bg-accent/10 focus:text-text-primary',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <BaseMenu.CheckboxItemIndicator>
        <Check className="text-accent h-4 w-4" />
      </BaseMenu.CheckboxItemIndicator>
    </span>
    {children}
  </BaseMenu.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

const DropdownMenuRadioItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem>
>(({ className, children, ...props }, ref) => (
  <BaseMenu.RadioItem
    ref={ref}
    className={cn(
      'relative flex cursor-pointer items-center rounded-sm py-1.5 pr-2 pl-8 font-mono text-sm transition-colors outline-none select-none',
      'focus:bg-accent/10 focus:text-text-primary',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <BaseMenu.RadioItemIndicator>
        <Circle className="fill-accent text-accent h-2 w-2" />
      </BaseMenu.RadioItemIndicator>
    </span>
    {children}
  </BaseMenu.RadioItem>
));
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

const DropdownMenuLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'text-accent px-2 py-1.5 font-mono text-xs font-bold tracking-wide uppercase',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseMenu.Separator>
>(({ className, ...props }, ref) => (
  <BaseMenu.Separator ref={ref} className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn('text-text-dim ml-auto font-mono text-xs tracking-widest', className)} {...props} />;
};
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
