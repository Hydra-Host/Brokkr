import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Checkbox } from '../checkbox';
import { Field, FieldDescription, FieldError } from '../field';

interface FormCheckboxProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label?: string;
  tooltip?: string;
  description?: string;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

function FormCheckbox<T extends FieldValues>({
  control,
  name,
  label,
  tooltip,
  description,
  onCheckedChange,
  disabled,
  className,
}: FormCheckboxProps<T>) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <Checkbox
            id={field.name}
            name={field.name}
            ref={field.ref}
            checked={!!field.value}
            onCheckedChange={(checked) => {
              field.onChange(checked);
              onCheckedChange?.(!!checked);
            }}
            onBlur={field.onBlur}
            disabled={disabled}
            label={label}
            tooltip={tooltip}
          />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export { FormCheckbox };
