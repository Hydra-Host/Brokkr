import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';

interface FormInputProps<T extends FieldValues> extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name'> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  labelRight?: React.ReactNode;
  description?: string;
}

function FormInput<T extends FieldValues>({
  control,
  name,
  label,
  labelRight,
  description,
  className,
  ...inputProps
}: FormInputProps<T>) {
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
          <Input {...field} {...inputProps} id={field.name} aria-invalid={fieldState.invalid} />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormInput };
