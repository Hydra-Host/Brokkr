import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';

interface FormNumberInputProps<T extends FieldValues>
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'type' | 'value' | 'onChange'> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  description?: string;
}

function FormNumberInput<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  ...inputProps
}: FormNumberInputProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
          <Input
            {...inputProps}
            id={field.name}
            type="number"
            name={field.name}
            ref={field.ref}
            onBlur={field.onBlur}
            value={field.value ?? ''}
            onChange={(e) => field.onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)}
            aria-invalid={fieldState.invalid}
          />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormNumberInput };
