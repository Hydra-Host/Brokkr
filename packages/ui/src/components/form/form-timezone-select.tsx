import type { Control, FieldValues, Path } from 'react-hook-form';
import { FormSelect } from './form-select';

const TIMEZONE_OPTIONS = Intl.supportedValuesOf('timeZone').map((tz) => ({ label: tz, value: tz }));

interface FormTimezoneSelectProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}

function FormTimezoneSelect<T extends FieldValues>({ label = 'Timezone', ...props }: FormTimezoneSelectProps<T>) {
  return <FormSelect {...props} label={label} options={TIMEZONE_OPTIONS} placeholder="Select a timezone" />;
}

export { FormTimezoneSelect, TIMEZONE_OPTIONS };
