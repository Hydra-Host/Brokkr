import { zodResolver } from '@hookform/resolvers/zod';
import { CircuitTerminationSideSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ZoneCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const editTerminationSchema = z.object({
  termSide: CircuitTerminationSideSchema,
  portSpeed: z.string(),
  upstreamSpeed: z.string(),
  xconnectId: z.string(),
  description: z.string(),
  zoneId: z.string(),
});

type EditTerminationFormData = z.infer<typeof editTerminationSchema>;

export const Route = createFileRoute('/_app/circuits/circuit-terminations/$terminationId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditCircuitTerminationPage,
});

function EditCircuitTerminationPage() {
  const { terminationId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCircuitTermination.useQuery({
    queryKey: ['circuit-termination', terminationId],
    queryData: { params: { id: terminationId } },
  });

  const updateMutation = tsr.updateCircuitTermination.useMutation({
    meta: { successMessage: 'Circuit termination updated' },
  });

  const termination = data?.status === 200 ? data.body : null;

  const { data: zoneData } = tsr.getZoneById.useQuery({
    queryKey: ['zone', termination?.zoneId],
    queryData: { params: { zoneId: termination?.zoneId ?? '' } },
    enabled: !!termination?.zoneId,
  });
  const zoneLabel = zoneData?.status === 200 ? zoneData.body.name : undefined;

  const { control, handleSubmit, reset } = useForm<EditTerminationFormData>({
    resolver: zodResolver(editTerminationSchema),
    defaultValues: {
      termSide: 'A',
      portSpeed: '',
      upstreamSpeed: '',
      xconnectId: '',
      description: '',
      zoneId: '',
    },
  });

  useEffect(() => {
    if (termination) {
      reset({
        termSide: termination.termSide,
        portSpeed: termination.portSpeed != null ? String(termination.portSpeed) : '',
        upstreamSpeed: termination.upstreamSpeed != null ? String(termination.upstreamSpeed) : '',
        xconnectId: termination.xconnectId ?? '',
        description: termination.description ?? '',
        zoneId: termination.zoneId ?? '',
      });
    }
  }, [termination, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!termination) return null;

  const onSubmit = async (formData: EditTerminationFormData) => {
    await updateMutation.mutateAsync({
      params: { id: terminationId },
      body: {
        termSide: formData.termSide,
        portSpeed: formData.portSpeed ? parseInt(formData.portSpeed, 10) : undefined,
        upstreamSpeed: formData.upstreamSpeed ? parseInt(formData.upstreamSpeed, 10) : undefined,
        xconnectId: formData.xconnectId || undefined,
        description: formData.description || undefined,
        zoneId: formData.zoneId || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['circuit-terminations'] });
    await queryClient.invalidateQueries({ queryKey: ['circuit-termination', terminationId] });
    navigate({ to: '/circuits/circuit-terminations/$terminationId', params: { terminationId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Circuit Termination</CardTitle>
        <CardDescription>Update details for termination {termination.termSide}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormSelect
            control={control}
            name="termSide"
            label="Term Side"
            options={enumOptions(CircuitTerminationSideSchema)}
            placeholder="Select side"
          />
          <FormInput control={control} name="portSpeed" label="Port Speed" description="Speed in Kbps" />
          <FormInput control={control} name="upstreamSpeed" label="Upstream Speed" description="Speed in Kbps" />
          <FormInput control={control} name="xconnectId" label="Cross-Connect ID" />
          <ZoneCombobox
            control={control}
            name="zoneId"
            seedOption={
              termination.zoneId ? { value: termination.zoneId, label: zoneLabel ?? termination.zoneId } : undefined
            }
          />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                navigate({ to: '/circuits/circuit-terminations/$terminationId', params: { terminationId } })
              }
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
