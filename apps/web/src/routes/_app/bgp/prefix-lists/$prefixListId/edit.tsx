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

const familyOptions = [
  { label: 'IPv4', value: 'ipv4' },
  { label: 'IPv6', value: 'ipv6' },
] as const;

const editPrefixListSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  family: z.string(),
});

type EditPrefixListFormData = z.infer<typeof editPrefixListSchema>;

export const Route = createFileRoute('/_app/bgp/prefix-lists/$prefixListId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditPrefixListPage,
});

function EditPrefixListPage() {
  const { prefixListId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPrefixList.useQuery({
    queryKey: ['prefix-list', prefixListId],
    queryData: { params: { id: prefixListId } },
  });

  const updateMutation = tsr.updatePrefixList.useMutation({
    meta: { successMessage: 'Prefix list updated' },
  });

  const prefixList = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditPrefixListFormData>({
    resolver: zodResolver(editPrefixListSchema),
    defaultValues: { name: '', description: '', family: '' },
  });

  useEffect(() => {
    if (prefixList) {
      reset({
        name: prefixList.name,
        description: prefixList.description ?? '',
        family: prefixList.family ?? '',
      });
    }
  }, [prefixList, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!prefixList) return null;

  const onSubmit = async (formData: EditPrefixListFormData) => {
    await updateMutation.mutateAsync({
      params: { id: prefixListId },
      body: {
        name: formData.name,
        description: formData.description || undefined,
        family: formData.family || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix-lists'] });
    await queryClient.invalidateQueries({ queryKey: ['prefix-list', prefixListId] });
    navigate({ to: '/bgp/prefix-lists/$prefixListId', params: { prefixListId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Prefix List</CardTitle>
        <CardDescription>Update details for {prefixList.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="name" label="Name" />
          <FormSelect
            control={control}
            name="family"
            label="Family"
            options={[...familyOptions]}
            placeholder="Select family"
            clearable
          />
          <FormTextarea control={control} name="description" label="Description" />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/bgp/prefix-lists/$prefixListId', params: { prefixListId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
