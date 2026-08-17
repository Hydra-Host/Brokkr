import { useEffect, useState } from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';

import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface FormMoneyInputProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  description?: string;
  disabled?: boolean;
  externalValue?: number;
  onValueChange?: (cents: number) => void;
}

function FormMoneyInput<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  externalValue,
  onValueChange,
}: FormMoneyInputProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <MoneyInputInner
          value={externalValue ?? (field.value as number)}
          onChange={(cents) => {
            if (externalValue !== undefined) {
              onValueChange?.(cents);
            } else {
              field.onChange(cents);
              onValueChange?.(cents);
            }
          }}
          name={`${field.name}-${label.replace(/\s+/g, '-').toLowerCase()}`}
          label={label}
          description={description}
          disabled={disabled}
          invalid={fieldState.invalid}
          error={fieldState.error}
        />
      )}
    />
  );
}

function MoneyInputInner({
  value,
  onChange,
  name,
  label,
  description,
  disabled,
  invalid,
  error,
}: {
  value: number;
  onChange: (cents: number) => void;
  name: string;
  label: string;
  description?: string;
  disabled?: boolean;
  invalid: boolean;
  error?: { message?: string };
}) {
  const [displayValue, setDisplayValue] = useState(() => moneyFormatter.format((value || 0) / 100));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setDisplayValue(moneyFormatter.format((value || 0) / 100));
    }
  }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, '');
    const cents = Number(raw);
    setDisplayValue(moneyFormatter.format(cents / 100));
    onChange(cents);
  };

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input
        id={name}
        value={displayValue}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        disabled={disabled}
        aria-invalid={invalid}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={[error]} />}
    </Field>
  );
}

export { FormMoneyInput };
