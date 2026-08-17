import { XCircle } from 'lucide-react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { cn } from '../utils';

interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

interface FormSelectProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  options: readonly SelectOption[];
  placeholder?: string;
  labelRight?: React.ReactNode;
  description?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  onValueChange?: (value: string) => void;
}

function FormSelect<T extends FieldValues>({
  control,
  name,
  label,
  options,
  placeholder,
  labelRight,
  description,
  clearable,
  disabled,
  className,
  triggerClassName,
  onValueChange,
}: FormSelectProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          {labelRight ? (
            <div className="flex items-center">
              <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
              <div className="ml-auto">{labelRight}</div>
            </div>
          ) : (
            <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
          )}
          <Select
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value);
              onValueChange?.(value);
            }}
            disabled={disabled}
          >
            <SelectTrigger
              id={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              error={fieldState.invalid ? 'true' : undefined}
              className={triggerClassName}
            >
              {clearable ? (
                <div className="flex w-full items-center justify-between gap-2">
                  <span className={cn('truncate', !field.value && 'text-text-dim')}>
                    {field.value ? (options.find((o) => o.value === field.value)?.label ?? field.value) : placeholder}
                  </span>
                  {field.value && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="text-muted-foreground hover:text-foreground flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        field.onChange('');
                        onValueChange?.('');
                      }}
                    >
                      <XCircle className="h-3 w-3" />
                    </span>
                  )}
                </div>
              ) : (
                <SelectValue placeholder={placeholder}>
                  {field.value ? (options.find((o) => o.value === field.value)?.label ?? field.value) : null}
                </SelectValue>
              )}
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormSelect, type SelectOption };
