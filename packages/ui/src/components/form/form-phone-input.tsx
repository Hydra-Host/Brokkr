import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import type { Value as PhoneValue } from 'react-phone-number-input';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { PhoneInput } from '../phone-input';

interface FormPhoneInputProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  labelRight?: React.ReactNode;
  description?: string;
  defaultCountry?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function FormPhoneInput<T extends FieldValues>({
  control,
  name,
  label,
  labelRight,
  description,
  defaultCountry,
  placeholder,
  disabled,
  className,
}: FormPhoneInputProps<T>) {
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
          <PhoneInput
            id={field.name}
            value={field.value as string}
            onChange={(value: PhoneValue) => {
              field.onChange(value || '');
            }}
            onBlur={field.onBlur}
            defaultCountry={defaultCountry as never}
            placeholder={placeholder}
            disabled={disabled}
          />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormPhoneInput };
