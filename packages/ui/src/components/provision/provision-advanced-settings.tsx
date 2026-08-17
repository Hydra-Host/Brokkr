import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type Control, type FieldValues, type UseFormSetValue, useFormState } from 'react-hook-form';

import { Button } from '../button';
import { cn } from '../utils';
import { CloudInitEditor } from './cloud-init-editor';
import { DiskLayoutSelector, type StorageLayouts } from './disk-layout-selector';

function getNestedErrors(errors: Record<string, any>, prefixes: { fieldPrefix: string; label: string }[]) {
  const grouped: { fieldPrefix: string; label: string; errors: string[] }[] = [];
  let hasErrors = false;

  for (const { fieldPrefix, label } of prefixes) {
    const fieldError = errors[fieldPrefix];
    if (!fieldError) continue;

    const messages: string[] = [];

    if (fieldError.message) {
      messages.push(fieldError.message);
    }

    if (Array.isArray(fieldError)) {
      for (const item of fieldError) {
        if (!item) continue;
        if (item.message) {
          messages.push(item.message);
        } else {
          for (const val of Object.values(item)) {
            if (val && typeof val === 'object' && 'message' in (val as any)) {
              messages.push((val as any).message);
            }
          }
        }
      }
    }

    if (messages.length > 0) {
      hasErrors = true;
      grouped.push({ fieldPrefix, label, errors: messages });
    }
  }

  return { grouped, hasErrors };
}

interface ProvisionAdvancedSettingsProps<T extends FieldValues = FieldValues> {
  storageLayouts: StorageLayouts;
  control: Control<T>;
  setValue: UseFormSetValue<T>;
  mode?: 'provision' | 'reprovision';
  disabled?: boolean;
  className?: string;
}

export function ProvisionAdvancedSettings<T extends FieldValues = FieldValues>({
  storageLayouts,
  control,
  setValue,
  mode = 'provision',
  disabled,
  className,
}: ProvisionAdvancedSettingsProps<T>) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const divRef = useRef<HTMLDivElement | null>(null);

  const { errors } = useFormState({ control });

  const { grouped: groupedErrors, hasErrors } = getNestedErrors(errors, [
    { fieldPrefix: 'diskLayouts', label: 'Disk Configuration' },
    { fieldPrefix: 'cloudInit', label: 'Cloud-Init' },
  ]);

  useEffect(() => {
    if (showAdvanced && divRef.current) {
      setTimeout(() => {
        divRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 150);
    }
  }, [showAdvanced]);

  return (
    <div className={className}>
      {!showAdvanced && hasErrors && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded-md p-3 text-sm">
          <div className="mb-2 font-medium">Advanced settings have validation errors:</div>

          {groupedErrors.map((group) => (
            <div key={group.fieldPrefix} className="mb-2 last:mb-0">
              <div className="mb-1 text-xs font-medium tracking-wider uppercase">{group.label}:</div>
              <ul className="list-disc space-y-1 pl-5">
                {group.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </div>
          ))}

          <div className="mt-2 text-xs opacity-75">Expand advanced settings to fix these errors.</div>
        </div>
      )}

      <div className="flex justify-start">
        <Button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          variant="link"
          className="flex justify-center gap-2 px-0 text-teal-400 hover:no-underline"
        >
          {showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 transition-transform duration-200', showAdvanced && 'rotate-180')}
          />
          {!showAdvanced && hasErrors && <span className="bg-destructive ml-1 inline-flex h-2 w-2 rounded-full" />}
        </Button>
      </div>

      <div
        className={cn(
          'flex flex-col gap-4 overflow-hidden transition-all duration-500 ease-in-out',
          showAdvanced ? 'h-full max-h-[3000px] opacity-100' : 'max-h-0 opacity-0',
        )}
        ref={divRef}
      >
        <DiskLayoutSelector
          storageLayouts={storageLayouts}
          control={control}
          setValue={setValue}
          mode={mode}
          disabled={disabled}
        />
        <CloudInitEditor control={control} disabled={disabled} />
      </div>
    </div>
  );
}
