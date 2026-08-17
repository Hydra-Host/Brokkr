import { zodResolver } from '@hookform/resolvers/zod';
import { CircuitStatusSchema } from '@repo/api-client';
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
import { CircuitTypeCombobox, ProviderCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const editCircuitSchema = z.object({
  cid: z.string().min(1, 'CID is required'),
  status: CircuitStatusSchema,
  providerId: z.string().min(1, 'Provider ID is required'),
  circuitTypeId: z.string().min(1, 'Circuit Type ID is required'),
  commitRate: z.string(),
  description: z.string(),
  comments: z.string(),
});

type EditCircuitFormData = z.infer<typeof editCircuitSchema>;

export const Route = createFileRoute('/_app/circuits/circuits/$circuitId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditCircuitPage,
});

function EditCircuitPage() {
  const { circuitId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCircuit.useQuery({
    queryKey: ['circuit', circuitId],
    queryData: { params: { id: circuitId } },
  });

  const updateMutation = tsr.updateCircuit.useMutation({
    meta: { successMessage: 'Circuit updated' },
  });

  const circuit = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditCircuitFormData>({
    resolver: zodResolver(editCircuitSchema),
    defaultValues: {
      cid: '',
      status: 'ACTIVE',
      providerId: '',
      circuitTypeId: '',
      commitRate: '',
      description: '',
      comments: '',
    },
  });

  useEffect(() => {
    if (circuit) {
      reset({
        cid: circuit.cid,
        status: circuit.status,
        providerId: circuit.providerId,
        circuitTypeId: circuit.circuitTypeId,
        commitRate: circuit.commitRate != null ? String(circuit.commitRate) : '',
        description: circuit.description ?? '',
        comments: circuit.comments ?? '',
      });
    }
  }, [circuit, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!circuit) return null;

  const onSubmit = async (formData: EditCircuitFormData) => {
    await updateMutation.mutateAsync({
      params: { id: circuitId },
      body: {
        cid: formData.cid,
        status: formData.status,
        providerId: formData.providerId,
        circuitTypeId: formData.circuitTypeId,
        commitRate: formData.commitRate ? parseInt(formData.commitRate, 10) : undefined,
        description: formData.description || undefined,
        comments: formData.comments || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['circuits'] });
    await queryClient.invalidateQueries({ queryKey: ['circuit', circuitId] });
    navigate({ to: '/circuits/circuits/$circuitId', params: { circuitId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Circuit</CardTitle>
        <CardDescription>Update details for {circuit.cid}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="cid" label="CID" />
          <FormSelect
            control={control}
            name="status"
            label="Status"
            options={enumOptions(CircuitStatusSchema)}
            placeholder="Select status"
          />
          <ProviderCombobox control={control} name="providerId" />
          <CircuitTypeCombobox control={control} name="circuitTypeId" />
          <FormInput control={control} name="commitRate" label="Commit Rate" description="Committed rate in Kbps" />
          <FormTextarea control={control} name="description" label="Description" />
          <FormTextarea control={control} name="comments" label="Comments" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/circuits/circuits/$circuitId', params: { circuitId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
