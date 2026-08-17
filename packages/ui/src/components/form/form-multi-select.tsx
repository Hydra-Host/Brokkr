import { Check, ChevronDown, X } from 'lucide-react';
import * as React from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Badge } from '../badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../command';
import { Field, FieldError, FieldLabel } from '../field';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { cn } from '../utils';

interface MultiSelectOption {
  label: string;
  value: string;
  keywords?: string[];
}

interface MultiSelectOptionGroup {
  label: string;
  options: MultiSelectOption[];
}

interface FormMultiSelectProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  options?: MultiSelectOption[];
  groups?: MultiSelectOptionGroup[];
  placeholder?: string;
  labelRight?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  onValueChange?: (values: string[]) => void;
  onSearchChange?: (search: string) => void;
  searchInProgress?: boolean;
  selectedLabelFallback?: (value: string) => string | undefined;
}

function FormMultiSelect<T extends FieldValues>({
  control,
  name,
  label,
  options,
  groups,
  placeholder = 'Select items...',
  labelRight,
  disabled,
  className,
  onValueChange,
  onSearchChange,
  searchInProgress = false,
  selectedLabelFallback,
}: FormMultiSelectProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [searchInput, setSearchInput] = React.useState('');
  const allOptions = groups ? groups.flatMap((g) => g.options) : (options ?? []);

  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => {
        const selectedValues: string[] = Array.isArray(field.value) ? field.value : [];

        const commit = (next: string[]) => {
          field.onChange(next);
          onValueChange?.(next);
        };

        const toggleValue = (value: string) => {
          const next = selectedValues.includes(value)
            ? selectedValues.filter((v) => v !== value)
            : [...selectedValues, value];
          commit(next);
        };

        const removeValue = (value: string) => {
          commit(selectedValues.filter((v) => v !== value));
        };

        const renderOption = (option: MultiSelectOption) => {
          const isSelected = selectedValues.includes(option.value);
          return (
            <CommandItem
              key={option.value}
              value={option.label}
              keywords={option.keywords}
              onSelect={() => toggleValue(option.value)}
            >
              <Check className={cn('mr-2 h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
              {option.label}
            </CommandItem>
          );
        };

        return (
          <Field data-invalid={fieldState.invalid} className={className}>
            {labelRight ? (
              <div className="flex items-center">
                <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
                <div className="ml-auto">{labelRight}</div>
              </div>
            ) : (
              <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            )}

            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <button
                  id={field.name}
                  role="combobox"
                  aria-expanded={open}
                  aria-invalid={fieldState.invalid ? true : undefined}
                  className={cn(
                    'group relative flex min-h-10 w-full items-center justify-between gap-x-1 px-3 py-2 font-mono text-sm',
                    'bg-bg-primary text-text-primary',
                    'border-text-muted border-t border-r-0 border-b border-l-0',
                    open && 'border-accent',
                    'focus:border-accent focus:outline-none',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    'aria-invalid:border-status-offline aria-invalid:focus:border-status-offline',
                  )}
                  disabled={disabled}
                  type="button"
                >
                  <div className="flex flex-1 flex-wrap gap-1">
                    {selectedValues.length === 0 ? (
                      <span className="text-text-dim">{placeholder}</span>
                    ) : (
                      selectedValues.map((val) => {
                        const opt = allOptions.find((o) => o.value === val);
                        const label = opt?.label ?? selectedLabelFallback?.(val) ?? val;
                        return (
                          <Badge key={val} variant="secondary" className="mr-1">
                            {label}
                            <span
                              role="button"
                              tabIndex={0}
                              className="focus:ring-accent ml-1 cursor-pointer rounded-full outline-none focus:ring-2 focus:ring-offset-2"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeValue(val);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  removeValue(val);
                                }
                              }}
                            >
                              <X className="h-3 w-3" />
                            </span>
                          </Badge>
                        );
                      })
                    )}
                  </div>
                  <ChevronDown className="text-text-muted ml-2 h-4 w-4 shrink-0" />
                  <span
                    className={cn(
                      'border-text-muted pointer-events-none absolute -top-px -left-px h-2 w-2 border-t border-l group-disabled:opacity-50',
                      open && 'border-accent',
                      'group-aria-invalid:border-status-offline',
                    )}
                  />
                  <span
                    className={cn(
                      'border-text-muted pointer-events-none absolute -top-px -right-px h-2 w-2 border-t border-r group-disabled:opacity-50',
                      open && 'border-accent',
                      'group-aria-invalid:border-status-offline',
                    )}
                  />
                  <span
                    className={cn(
                      'border-text-muted pointer-events-none absolute -bottom-px -left-px h-2 w-2 border-b border-l group-disabled:opacity-50',
                      open && 'border-accent',
                      'group-aria-invalid:border-status-offline',
                    )}
                  />
                  <span
                    className={cn(
                      'border-text-muted pointer-events-none absolute -right-px -bottom-px h-2 w-2 border-r border-b group-disabled:opacity-50',
                      open && 'border-accent',
                      'group-aria-invalid:border-status-offline',
                    )}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command shouldFilter={!onSearchChange}>
                  <CommandInput
                    placeholder="Search..."
                    {...(onSearchChange && {
                      value: searchInput,
                      onValueChange: (v) => {
                        setSearchInput(v);
                        onSearchChange(v);
                      },
                    })}
                  />
                  <CommandList>
                    <CommandEmpty>{searchInProgress ? 'searching...' : 'No items found.'}</CommandEmpty>
                    {groups ? (
                      groups.map((group, index) => (
                        <React.Fragment key={group.label}>
                          {index > 0 && <CommandSeparator />}
                          <CommandGroup heading={group.label}>{group.options.map(renderOption)}</CommandGroup>
                        </React.Fragment>
                      ))
                    ) : (
                      <CommandGroup>{allOptions.map(renderOption)}</CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        );
      }}
    />
  );
}

export { FormMultiSelect, type MultiSelectOption, type MultiSelectOptionGroup };
