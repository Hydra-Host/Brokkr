import clsx from 'clsx';
import { Check, ChevronDown, InfoIcon } from 'lucide-react';
import * as React from 'react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
import { Label } from './label';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { cn } from './utils';

interface ComboboxWrapperProps {
  children: React.ReactNode;
  label?: string;
  tooltip?: string;
  error?: string;
  className?: string;
  id?: string;
}

const ComboboxWrapper: React.FC<ComboboxWrapperProps> = ({ children, label, tooltip, error, className, id }) => {
  return (
    <div className={clsx('flex w-full flex-col gap-2', className)}>
      {label && (
        <div className="flex h-6 items-center gap-2">
          <Label htmlFor={id}>{label}</Label>
          {tooltip && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <InfoIcon className="h-4 w-4 cursor-help" />
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

export type ComboboxProps = {
  options: {
    value: string;
    label: string;
    description?: string;
    icon?: React.ReactNode;
    iconClassName?: string;
  }[];
  value: string | undefined;
  setValue: (value: string) => void;
  placeholder: string;
  triggerClassName?: string;
  contentClassName?: string;
  commandClassName?: string;
  commandItemClassName?: string;
  hideIcon?: boolean;
  searchPlaceholder?: string;
  filter?: (value: string, search: string, keywords?: string[]) => number;
  disabled?: boolean;
  error?: string;
  id?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  shouldFilter?: boolean;
  emptyMessage?: React.ReactNode;
};

function Combobox({
  options,
  placeholder,
  value,
  setValue,
  triggerClassName,
  contentClassName,
  commandClassName,
  commandItemClassName,
  filter,
  hideIcon,
  searchPlaceholder,
  disabled,
  error,
  id,
  searchValue,
  onSearchChange,
  shouldFilter,
  emptyMessage,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const hasValue = value != null && value !== '';

  // cmdk bug (issues #389/#374): list scrolls to a stale item on search change — defer past cmdk's scrollSelectedIntoView, then snap to top.
  const handleSearchChange = React.useCallback(
    (next: string) => {
      onSearchChange?.(next);
      setTimeout(() => {
        listRef.current?.scrollTo({ top: 0, behavior: 'instant' });
      });
    },
    [onSearchChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          className={cn(
            'group flex h-10 w-full items-center justify-between gap-x-1 px-3 py-2 font-mono text-sm',
            'bg-bg-primary text-text-primary',
            'border-text-muted border-t border-r-0 border-b border-l-0',
            'focus:border-accent focus:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            '[&>span]:line-clamp-1',
            'relative cursor-pointer',
            !hasValue && 'text-text-dim',
            error ? 'border-status-offline focus:border-status-offline' : '',
            triggerClassName,
          )}
          disabled={disabled}
        >
          <span>
            {hasValue
              ? (options.find((option) => option.value.toLowerCase() === value.toLowerCase())?.label ?? placeholder)
              : placeholder}
          </span>
          {!hideIcon && <ChevronDown className="text-text-muted h-4 w-4" />}
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -top-px -left-px h-2 w-2 border-t border-l group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -top-px -right-px h-2 w-2 border-t border-r group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -bottom-px -left-px h-2 w-2 border-b border-l group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent group-aria-invalid:border-status-offline pointer-events-none absolute -right-px -bottom-px h-2 w-2 border-r border-b group-disabled:opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('max-h-96 w-[var(--anchor-width)] overflow-scroll p-0', contentClassName)}
        align="start"
      >
        <Command
          className={commandClassName}
          filter={filter}
          shouldFilter={shouldFilter ?? (onSearchChange ? false : undefined)}
        >
          <CommandInput
            placeholder={searchPlaceholder ?? placeholder}
            value={searchValue}
            onValueChange={handleSearchChange}
          />
          <CommandList ref={listRef}>
            <CommandEmpty>{emptyMessage ?? 'Nothing found.'}</CommandEmpty>
            <CommandGroup>
              {options.map((option, index) => {
                const itemValue = option.value || option.label;
                return (
                  <CommandItem
                    key={option.value || `__empty__-${index}`}
                    value={itemValue}
                    keywords={[option.label, ...(option.description ? [option.description] : [])]}
                    onSelect={(currentValue) => {
                      const selectedOption = options.find(
                        (opt) => (opt.value || opt.label).toLowerCase() === currentValue.toLowerCase(),
                      );
                      const originalValue = selectedOption ? selectedOption.value : currentValue;
                      setValue(
                        value !== undefined && originalValue.toLowerCase() === value.toLowerCase() ? '' : originalValue,
                      );
                      setOpen(false);
                    }}
                    className={commandItemClassName}
                  >
                    <Check
                      className={cn(
                        'text-accent mr-2 h-4 w-4',
                        value !== undefined && value.toLowerCase() === option.value.toLowerCase()
                          ? 'opacity-100'
                          : 'opacity-0',
                      )}
                    />
                    <div className="flex flex-col">
                      <div className="flex items-center justify-between">
                        <span>{option.label}</span>
                        {option.icon && <span className={cn('ml-2', option.iconClassName)}>{option.icon}</span>}
                      </div>
                      {option.description && <span className="text-text-dim text-sm">{option.description}</span>}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox, ComboboxWrapper };
