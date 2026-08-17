import { zodResolver } from '@hookform/resolvers/zod';
import { DcimRackStatusSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ZoneCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const createSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  status: DcimRackStatusSchema,
  zoneId: z.string().uuid('Zone ID is required'),
  heightU: z.coerce.number().int().min(1, 'Height must be at least 1'),
  startingUnit: z.coerce.number().int().min(1, 'Starting unit must be at least 1'),
  serial: z.string(),
  assetTag: z.string(),
  description: z.string(),
});

type CreateFormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/dcim/racks/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateRackPage,
});

function CreateRackPage() {
  useDocumentTitle('Create Rack');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDcimRack.useMutation({
    meta: { successMessage: 'Rack created' },
  });

  const { control, handleSubmit } = useForm<CreateFormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      status: 'ACTIVE',
      zoneId: '',
      heightU: 42,
      startingUnit: 1,
      serial: '',
      assetTag: '',
      description: '',
    },
  });

  const onSubmit = async (data: CreateFormData) => {
    await create({
      body: {
        name: data.name,
        status: data.status,
        zoneId: data.zoneId,
        heightU: data.heightU,
        startingUnit: data.startingUnit,
        serial: data.serial || undefined,
        assetTag: data.assetTag || undefined,
        description: data.description || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-racks'] });
    navigate({ to: '/dcim/racks' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Rack Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="name" label="Name" />
            <ZoneCombobox control={control} name="zoneId" />
            <FormSelect control={control} name="status" label="Status" options={enumOptions(DcimRackStatusSchema)} />
            <FormInput control={control} name="heightU" label="Height (U)" />
            <FormInput control={control} name="startingUnit" label="Starting Unit" />
            <FormInput control={control} name="serial" label="Serial" />
            <FormInput control={control} name="assetTag" label="Asset Tag" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Rack'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/dcim/racks' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
