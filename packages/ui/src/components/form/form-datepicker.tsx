import { format } from 'date-fns';
import { Calendar as CalendarIcon, Clock } from 'lucide-react';
import { useState } from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Button } from '../button';
import { Calendar } from '../calendar';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { cn } from '../utils';

interface FormDatePickerProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  labelRight?: React.ReactNode;
  description?: string;
  minDate?: Date;
  maxDate?: Date;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  withTime?: boolean;
}

function FormDatePicker<T extends FieldValues>({
  control,
  name,
  label,
  labelRight,
  description,
  minDate,
  maxDate,
  placeholder = 'Pick a date',
  disabled,
  className,
  withTime = false,
}: FormDatePickerProps<T>) {
  const [open, setOpen] = useState(false);

  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => {
        const dateValue = field.value ? new Date(field.value as string) : undefined;

        const timeString = dateValue
          ? `${String(dateValue.getHours()).padStart(2, '0')}:${String(dateValue.getMinutes()).padStart(2, '0')}`
          : '00:00';

        const handleDateSelect = (date: Date | undefined) => {
          if (!date) {
            field.onChange('');
            if (!withTime) setOpen(false);
            return;
          }
          const next = new Date(date);
          if (withTime && dateValue) {
            next.setHours(dateValue.getHours(), dateValue.getMinutes(), 0, 0);
          } else {
            next.setHours(0, 0, 0, 0);
          }
          field.onChange(next.toISOString());
          if (!withTime) setOpen(false);
        };

        const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
          if (!dateValue) return;
          const [h, m] = e.target.value.split(':').map(Number);
          const base = new Date(dateValue);
          base.setHours(h || 0, m || 0, 0, 0);
          field.onChange(base.toISOString());
        };

        const displayLabel =
          withTime && dateValue ? format(dateValue, 'PPP p') : dateValue ? format(dateValue, 'PPP') : undefined;

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
                <Button
                  id={field.name}
                  ref={field.ref}
                  variant="outline"
                  disabled={disabled}
                  onBlur={field.onBlur}
                  className={cn(
                    'w-full justify-start text-left font-mono',
                    !dateValue && 'text-text-dim',
                    fieldState.invalid && 'border-status-offline',
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {displayLabel ?? <span>{placeholder}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateValue}
                  onSelect={handleDateSelect}
                  fromDate={minDate}
                  toDate={maxDate}
                  initialFocus
                />
                {withTime && (
                  <div className="border-border flex items-center gap-2 border-t px-3 py-3">
                    <Clock className="text-muted-foreground h-4 w-4 shrink-0" />
                    <Input type="time" value={timeString} onChange={handleTimeChange} className="font-mono" />
                    <Button size="sm" variant="outline" onClick={() => setOpen(false)} type="button">
                      Done
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            {description && <FieldDescription>{description}</FieldDescription>}
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        );
      }}
    />
  );
}

export { FormDatePicker };
