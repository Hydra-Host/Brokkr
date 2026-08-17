import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const createAsnSchema = z.object({
  asn: z.coerce.number().int().min(1, 'ASN is required').max(2147483647, 'ASN must be at most 2147483647'),
  description: z.string(),
});

type CreateAsnFormData = z.infer<typeof createAsnSchema>;

export const Route = createFileRoute('/_app/ipam/asns/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateAsnPage,
});

function CreateAsnPage() {
  useDocumentTitle('Create ASN');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createAsn, isPending } = tsr.createAsn.useMutation({
    meta: { successMessage: 'ASN created' },
  });

  const { control, handleSubmit } = useForm<CreateAsnFormData>({
    resolver: zodResolver(createAsnSchema),
    defaultValues: {
      asn: 0,
      description: '',
    },
  });

  const onSubmit = async (data: CreateAsnFormData) => {
    await createAsn({
      body: {
        asn: data.asn,
        description: data.description || null,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['asns'] });
    navigate({ to: '/ipam/asns' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>ASN Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="asn" label="ASN" type="number" description="Autonomous System Number" />
            <FormTextarea control={control} name="description" label="Description" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create ASN'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/asns' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
