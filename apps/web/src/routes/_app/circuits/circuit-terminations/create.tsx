import { zodResolver } from '@hookform/resolvers/zod';
import { CircuitTerminationSideSchema } from '@repo/api-client';
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
import { CircuitCombobox, ZoneCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const createTerminationSchema = z.object({
  termSide: CircuitTerminationSideSchema,
  portSpeed: z.string(),
  upstreamSpeed: z.string(),
  xconnectId: z.string(),
  description: z.string(),
  circuitId: z.string().min(1, 'Circuit ID is required'),
  zoneId: z.string(),
});

type CreateTerminationFormData = z.infer<typeof createTerminationSchema>;

export const Route = createFileRoute('/_app/circuits/circuit-terminations/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateCircuitTerminationPage,
});

function CreateCircuitTerminationPage() {
  useDocumentTitle('Create Circuit Termination');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createTermination, isPending } = tsr.createCircuitTermination.useMutation({
    meta: { successMessage: 'Circuit termination created' },
  });

  const { control, handleSubmit } = useForm<CreateTerminationFormData>({
    resolver: zodResolver(createTerminationSchema),
    defaultValues: {
      termSide: 'A',
      portSpeed: '',
      upstreamSpeed: '',
      xconnectId: '',
      description: '',
      circuitId: '',
      zoneId: '',
    },
  });

  const onSubmit = async (data: CreateTerminationFormData) => {
    await createTermination({
      body: {
        termSide: data.termSide,
        portSpeed: data.portSpeed ? parseInt(data.portSpeed, 10) : undefined,
        upstreamSpeed: data.upstreamSpeed ? parseInt(data.upstreamSpeed, 10) : undefined,
        xconnectId: data.xconnectId || undefined,
        description: data.description || undefined,
        circuitId: data.circuitId,
        zoneId: data.zoneId || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['circuit-terminations'] });
    navigate({ to: '/circuits/circuit-terminations' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Circuit Termination Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormSelect
              control={control}
              name="termSide"
              label="Term Side"
              options={enumOptions(CircuitTerminationSideSchema)}
              placeholder="Select side"
            />
            <CircuitCombobox control={control} name="circuitId" />
            <FormInput control={control} name="portSpeed" label="Port Speed" description="Speed in Kbps" />
            <FormInput control={control} name="upstreamSpeed" label="Upstream Speed" description="Speed in Kbps" />
            <FormInput control={control} name="xconnectId" label="Cross-Connect ID" />
            <ZoneCombobox control={control} name="zoneId" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Termination'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/circuits/circuit-terminations' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
