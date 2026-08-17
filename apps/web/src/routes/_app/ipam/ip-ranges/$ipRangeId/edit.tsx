import { zodResolver } from '@hookform/resolvers/zod';
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
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
] as const;

const editIpRangeSchema = z.object({
  start: z.string().min(1, 'Start address is required'),
  end: z.string().min(1, 'End address is required'),
  status: z.string(),
  purpose: z.string(),
});

type EditIpRangeFormData = z.infer<typeof editIpRangeSchema>;

export const Route = createFileRoute('/_app/ipam/ip-ranges/$ipRangeId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditIpRangePage,
});

function EditIpRangePage() {
  const { ipRangeId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getIpRange.useQuery({
    queryKey: ['ip-range', ipRangeId],
    queryData: { params: { id: ipRangeId } },
  });

  const updateMutation = tsr.updateIpRange.useMutation({
    meta: { successMessage: 'IP range updated' },
  });

  const ipRange = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditIpRangeFormData>({
    resolver: zodResolver(editIpRangeSchema),
    defaultValues: { start: '', end: '', status: 'ACTIVE', purpose: '' },
  });

  useEffect(() => {
    if (ipRange) {
      reset({
        start: ipRange.start,
        end: ipRange.end,
        status: ipRange.status,
        purpose: ipRange.purpose ?? '',
      });
    }
  }, [ipRange, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!ipRange) return null;

  const onSubmit = async (formData: EditIpRangeFormData) => {
    await updateMutation.mutateAsync({
      params: { id: ipRangeId },
      body: {
        start: formData.start,
        end: formData.end,
        status: formData.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED',
        purpose: formData.purpose || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['ip-ranges'] });
    await queryClient.invalidateQueries({ queryKey: ['ip-range', ipRangeId] });
    navigate({ to: '/ipam/ip-ranges/$ipRangeId', params: { ipRangeId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit IP Range</CardTitle>
        <CardDescription>
          Update details for {ipRange.start} - {ipRange.end}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="start" label="Start Address" description="Start of the IP range" />
          <FormInput control={control} name="end" label="End Address" description="End of the IP range" />
          <FormSelect
            control={control}
            name="status"
            label="Status"
            options={statusOptions}
            placeholder="Select status"
          />
          <FormTextarea control={control} name="purpose" label="Purpose" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/ipam/ip-ranges/$ipRangeId', params: { ipRangeId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
