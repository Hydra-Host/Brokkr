import { zodResolver } from '@hookform/resolvers/zod';
import { useSession } from '@repo/auth/client';
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
import { tsr } from '~/lib/api';

const familyOptions = [
  { label: 'IPv4', value: 'ipv4' },
  { label: 'IPv6', value: 'ipv6' },
] as const;

const createPrefixListSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  family: z.string(),
});

type CreatePrefixListFormData = z.infer<typeof createPrefixListSchema>;

export const Route = createFileRoute('/_app/bgp/prefix-lists/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreatePrefixListPage,
});

function CreatePrefixListPage() {
  useDocumentTitle('Create Prefix List');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId ?? '';

  const { mutateAsync: createPrefixList, isPending } = tsr.createPrefixList.useMutation({
    meta: { successMessage: 'Prefix list created' },
  });

  const { control, handleSubmit } = useForm<CreatePrefixListFormData>({
    resolver: zodResolver(createPrefixListSchema),
    defaultValues: {
      name: '',
      description: '',
      family: '',
    },
  });

  const onSubmit = async (data: CreatePrefixListFormData) => {
    await createPrefixList({
      body: {
        name: data.name,
        description: data.description || undefined,
        family: data.family || undefined,
        organizationId: activeOrgId || undefined,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix-lists'] });
    navigate({ to: '/bgp/prefix-lists' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Prefix List Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Prefix List'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/bgp/prefix-lists' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
