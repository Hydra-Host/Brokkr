import { useEffect, useState } from 'react';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';

import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';

interface FormMarginInputProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  description?: string;
  disabled?: boolean;
  onValueChange?: (decimal: number) => void;
}

function FormMarginInput<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  onValueChange,
}: FormMarginInputProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <MarginInputInner
          value={field.value as number}
          onChange={(decimal) => {
            field.onChange(decimal);
            onValueChange?.(decimal);
          }}
          name={field.name}
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

function MarginInputInner({
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
  onChange: (decimal: number) => void;
  name: string;
  label: string;
  description?: string;
  disabled?: boolean;
  invalid: boolean;
  error?: { message?: string };
}) {
  const [displayValue, setDisplayValue] = useState<string>(() => {
    const pct = (value || 0) * 100;
    return pct === 0 ? '0' : Number(pct.toFixed(2)).toString();
  });

  useEffect(() => {
    const pct = (value || 0) * 100;
    setDisplayValue(pct === 0 ? '0' : Number(pct.toFixed(2)).toString());
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;

    if (!/^\d*\.?\d*$/.test(raw)) return;

    if (raw === '') {
      setDisplayValue('');
      onChange(0);
      return;
    }

    if (Number(raw) > 100) return;

    setDisplayValue(raw);
    const decimal = raw === '.' ? 0 : Number((Number(raw) / 100).toFixed(4));
    onChange(decimal);
  };

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <div className="relative">
        <Input
          id={name}
          value={displayValue}
          onChange={handleChange}
          disabled={disabled}
          aria-invalid={invalid}
          className="pr-8"
        />
        <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">
          %
        </span>
      </div>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError errors={[error]} />}
    </Field>
  );
}

export { FormMarginInput };
