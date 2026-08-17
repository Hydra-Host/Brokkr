import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const createSchema = z.object({
  manufacturer: z.string().min(1, 'Manufacturer is required'),
  model: z.string().min(1, 'Model is required'),
  formFactor: z.string(),
  description: z.string(),
  isFullDepth: z.boolean(),
  heightU: z.coerce.number().int().min(0).optional().or(z.literal('')),
  maxPowerW: z.coerce.number().int().min(0).optional().or(z.literal('')),
});

type FormData = z.infer<typeof createSchema>;

export const Route = createFileRoute('/_app/device-models/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateDeviceModelPage,
});

function CreateDeviceModelPage() {
  useDocumentTitle('Create Device Model');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: create, isPending } = tsr.createDeviceModel.useMutation({
    meta: { successMessage: 'Device model created' },
  });

  const { control, handleSubmit } = useForm<FormData>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      manufacturer: '',
      model: '',
      formFactor: '',
      description: '',
      isFullDepth: true,
      heightU: '',
      maxPowerW: '',
    },
  });

  const onSubmit = async (data: FormData) => {
    await create({
      body: {
        manufacturer: data.manufacturer,
        model: data.model,
        formFactor: data.formFactor || null,
        description: data.description || null,
        isFullDepth: data.isFullDepth,
        heightU: typeof data.heightU === 'number' ? data.heightU : null,
        maxPowerW: typeof data.maxPowerW === 'number' ? data.maxPowerW : null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['device-models'] });
    navigate({ to: '/device-models' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Device Model Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="manufacturer" label="Manufacturer" />
            <FormInput control={control} name="model" label="Model" />
            <FormInput control={control} name="formFactor" label="Form Factor" description="e.g. 1U, 2U, blade" />
            <FormTextarea control={control} name="description" label="Description" />
            <FormCheckbox
              control={control}
              name="isFullDepth"
              label="Full depth"
              description="Occupies the full depth of a rack"
            />
            <FormInput
              control={control}
              name="heightU"
              label="Height (U)"
              type="number"
              description="Height in rack units"
            />
            <FormInput
              control={control}
              name="maxPowerW"
              label="Max Power (W)"
              type="number"
              description="Maximum power draw in watts"
            />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Device Model'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/device-models' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
