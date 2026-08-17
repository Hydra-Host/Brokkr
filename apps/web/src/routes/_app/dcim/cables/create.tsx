import { zodResolver } from '@hookform/resolvers/zod';
import {
  DcimCableLengthUnitSchema,
  DcimCableStatusSchema,
  DcimCableTerminationTypeSchema,
  DcimCableTypeSchema,
} from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';
import { CableTerminationPicker } from './-termination-picker';

const createSchema = z.object({
  type: DcimCableTypeSchema.or(z.literal('')),
  status: DcimCableStatusSchema.or(z.literal('')),
  label: z.string(),
  color: z.string(),
  length: z.string(),
  lengthUnit: DcimCableLengthUnitSchema.or(z.literal('')),
  description: z.string(),
  aDeviceId: z.string().min(1, 'Select a device'),
  aType: DcimCableTerminationTypeSchema.or(z.literal('')),
  aPortId: z.string().min(1, 'Select a port'),
  bDeviceId: z.string().min(1, 'Select a device'),
  bType: DcimCableTerminationTypeSchema.or(z.literal('')),
  bPortId: z.string().min(1, 'Select a port'),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/cables/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateCablePage,
});

function CreateCablePage() {
  useDocumentTitle('Create Cable');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDcimCable.useMutation({
    meta: { successMessage: 'Cable created' },
  });

  const { control, handleSubmit, setValue } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      type: '',
      status: '',
      label: '',
      color: '',
      length: '',
      lengthUnit: '',
      description: '',
      aDeviceId: '',
      aType: '',
      aPortId: '',
      bDeviceId: '',
      bType: '',
      bPortId: '',
    },
  });

  const resetAPort = useCallback(() => setValue('aPortId', ''), [setValue]);
  const resetBPort = useCallback(() => setValue('bPortId', ''), [setValue]);

  const onSubmit = async (data: CreateFormData) => {
    if (!data.aType || !data.bType) return;
    await create({
      body: {
        type: data.type || undefined,
        status: data.status || undefined,
        label: data.label || undefined,
        color: data.color || undefined,
        length: data.length ? parseFloat(data.length) : undefined,
        lengthUnit: data.lengthUnit || undefined,
        description: data.description || undefined,
        aTermination: { type: data.aType, id: data.aPortId },
        bTermination: { type: data.bType, id: data.bPortId },
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-cables'] });
    navigate({ to: '/dcim/cables' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Cable Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="label" label="Label" />
            <FormSelect
              control={control}
              name="type"
              label="Type"
              options={enumOptions(DcimCableTypeSchema, { COAX: 'Coax' })}
              placeholder="Select type"
            />
            <FormSelect
              control={control}
              name="status"
              label="Status"
              options={enumOptions(DcimCableStatusSchema)}
              placeholder="Select status"
            />
            <FormInput control={control} name="color" label="Color" description="Hex color code (e.g. #ff0000)" />
            <FormInput control={control} name="length" label="Length" />
            <FormSelect
              control={control}
              name="lengthUnit"
              label="Length Unit"
              options={enumOptions(DcimCableLengthUnitSchema, { FEET: 'Feet' })}
              placeholder="Select length unit"
            />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <CableTerminationPicker
            control={control}
            resetPort={resetAPort}
            deviceName="aDeviceId"
            typeName="aType"
            portName="aPortId"
            title="A-side termination"
          />
          <CableTerminationPicker
            control={control}
            resetPort={resetBPort}
            deviceName="bDeviceId"
            typeName="bType"
            portName="bPortId"
            title="B-side termination"
          />
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Cable'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/cables' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
