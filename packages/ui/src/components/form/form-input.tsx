import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { Input } from '../input';

interface FormInputProps<T extends FieldValues> extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name'> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  labelRight?: React.ReactNode;
  description?: string;
  /** Render the label `sr-only`, for table rows with one shared column header. Out of flow, so it adds no row height. */
  hideLabel?: boolean;
}

function FormInput<T extends FieldValues>({
  control,
  name,
  label,
  labelRight,
  description,
  hideLabel,
  className,
  ...inputProps
}: FormInputProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => {
        const fieldLabel = (
          <FieldLabel htmlFor={field.name} className={hideLabel ? 'sr-only' : undefined}>
            {label}
          </FieldLabel>
        );
        return (
          <Field data-invalid={fieldState.invalid} className={className}>
            {labelRight ? (
              <div className="flex items-center">
                {fieldLabel}
                <div className="ml-auto">{labelRight}</div>
              </div>
            ) : (
              fieldLabel
            )}
            <Input {...field} {...inputProps} id={field.name} aria-invalid={fieldState.invalid} />
            {description && <FieldDescription>{description}</FieldDescription>}
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        );
      }}
    />
  );
}

export { FormInput };
