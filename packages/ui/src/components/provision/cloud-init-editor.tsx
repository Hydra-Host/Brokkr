import { load } from 'js-yaml';
import { AlertCircle } from 'lucide-react';
import { useCallback, useState } from 'react';
import { type Control, Controller, type FieldValues, Path } from 'react-hook-form';

import { Alert, AlertDescription } from '../alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../card';
import { Field, FieldError, FieldLabel } from '../field';
import { Textarea } from '../textarea';

const CLOUD_INIT_PLACEHOLDER = `#cloud-config
# Example cloud-init configuration
users:
  - name: myuser
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAA...

packages:
  - htop
  - vim

runcmd:
  - echo "Hello from cloud-init"`;

const UNSUPPORTED_PROPERTIES = [
  'disk_setup',
  'fs_setup',
  'device_aliases',
  'datasource',
  'network-config',
  'network-interfaces',
];

interface CloudInitEditorProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  disabled?: boolean;
  name?: Path<T>;
}

export function CloudInitEditor<T extends FieldValues = FieldValues>({
  control,
  disabled,
  name = 'cloudInit' as Path<T>,
}: CloudInitEditorProps<T>) {
  const [yamlError, setYamlError] = useState<string | null>(null);

  const validateYaml = useCallback((value: string) => {
    if (!value.trim()) {
      setYamlError(null);
      return;
    }
    try {
      load(value);
      setYamlError(null);
    } catch (e) {
      if (e instanceof Error) {
        setYamlError(e.message.split('\n')[0]);
      }
    }
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cloud Init</CardTitle>
        <CardDescription>
          Enter your cloud-init configuration in YAML format.
          <br />
          <span className="text-sm text-yellow-500">
            The following properties are not supported and will be ignored:{' '}
            {UNSUPPORTED_PROPERTIES.map((prop, i) => (
              <span key={prop}>
                <code>{prop}</code>
                {i < UNSUPPORTED_PROPERTIES.length - 1 ? ', ' : ''}
              </span>
            ))}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Controller
          name={name}
          control={control}
          render={({ field, fieldState }) => (
            <>
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="cloudInit">Configuration (YAML)</FieldLabel>
                <Textarea
                  {...field}
                  id="cloudInit"
                  placeholder={CLOUD_INIT_PLACEHOLDER}
                  rows={25}
                  disabled={disabled}
                  onChange={(e) => {
                    field.onChange(e);
                    validateYaml(e.target.value);
                  }}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            </>
          )}
        />

        {yamlError && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{yamlError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
