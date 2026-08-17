import { zodResolver } from '@hookform/resolvers/zod';
import { CircuitStatusSchema } from '@repo/api-client';
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
import { CircuitTypeCombobox, ProviderCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

const createCircuitSchema = z.object({
  cid: z.string().min(1, 'CID is required'),
  status: CircuitStatusSchema,
  providerId: z.string().min(1, 'Provider ID is required'),
  circuitTypeId: z.string().min(1, 'Circuit Type ID is required'),
  commitRate: z.string(),
  description: z.string(),
  comments: z.string(),
});

type CreateCircuitFormData = z.infer<typeof createCircuitSchema>;

export const Route = createFileRoute('/_app/circuits/circuits/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateCircuitPage,
});

function CreateCircuitPage() {
  useDocumentTitle('Create Circuit');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createCircuit, isPending } = tsr.createCircuit.useMutation({
    meta: { successMessage: 'Circuit created' },
  });

  const { control, handleSubmit } = useForm<CreateCircuitFormData>({
    resolver: zodResolver(createCircuitSchema),
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

  const onSubmit = async (data: CreateCircuitFormData) => {
    await createCircuit({
      body: {
        cid: data.cid,
        status: data.status,
        providerId: data.providerId,
        circuitTypeId: data.circuitTypeId,
        commitRate: data.commitRate ? parseInt(data.commitRate, 10) : undefined,
        description: data.description || undefined,
        comments: data.comments || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['circuits'] });
    navigate({ to: '/circuits/circuits' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Circuit Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Circuit'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/circuits/circuits' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
