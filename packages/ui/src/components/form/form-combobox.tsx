import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Combobox, type ComboboxProps } from '../combobox';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';

interface FormComboboxProps<T extends FieldValues> extends Omit<ComboboxProps, 'value' | 'setValue' | 'error'> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  labelRight?: React.ReactNode;
  description?: string;
  className?: string;
}

function FormCombobox<T extends FieldValues>({
  control,
  name,
  label,
  labelRight,
  description,
  className,
  ...comboboxProps
}: FormComboboxProps<T>) {
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
          <Combobox
            {...comboboxProps}
            id={field.name}
            value={field.value}
            setValue={(val) => {
              field.onChange(val);
              field.onBlur();
            }}
            error={fieldState.invalid ? 'true' : undefined}
          />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormCombobox };
