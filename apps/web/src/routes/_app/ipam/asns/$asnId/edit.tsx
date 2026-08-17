import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const editAsnSchema = z.object({
  asn: z.coerce.number().int().min(1, 'ASN is required').max(2147483647, 'ASN must be at most 2147483647'),
  description: z.string(),
});

type EditAsnFormData = z.infer<typeof editAsnSchema>;

export const Route = createFileRoute('/_app/ipam/asns/$asnId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditAsnPage,
});

function EditAsnPage() {
  const { asnId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getAsn.useQuery({
    queryKey: ['asn', asnId],
    queryData: { params: { id: asnId } },
  });

  const updateMutation = tsr.updateAsn.useMutation({
    meta: { successMessage: 'ASN updated' },
  });

  const asn = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditAsnFormData>({
    resolver: zodResolver(editAsnSchema),
    defaultValues: { asn: 0, description: '' },
  });

  useEffect(() => {
    if (asn) {
      reset({
        asn: asn.asn,
        description: asn.description ?? '',
      });
    }
  }, [asn, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!asn) return null;

  const onSubmit = async (formData: EditAsnFormData) => {
    await updateMutation.mutateAsync({
      params: { id: asnId },
      body: {
        asn: formData.asn,
        description: formData.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['asns'] });
    await queryClient.invalidateQueries({ queryKey: ['asn', asnId] });
    navigate({ to: '/ipam/asns/$asnId', params: { asnId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit ASN</CardTitle>
        <CardDescription>Update details for AS{asn.asn}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="asn" label="ASN" type="number" description="Autonomous System Number" />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/asns/$asnId', params: { asnId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
