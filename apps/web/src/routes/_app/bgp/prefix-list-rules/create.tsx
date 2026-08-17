import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PrefixListCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const actionOptions = [
  { label: 'Permit', value: 'permit' },
  { label: 'Deny', value: 'deny' },
] as const;

const createRuleSchema = z.object({
  action: z.string().min(1, 'Action is required'),
  prefix: z.string(),
  ge: z.string(),
  le: z.string(),
  sequence: z.string().min(1, 'Sequence is required'),
  prefixListId: z.string().min(1, 'Prefix List ID is required'),
});

type CreateRuleFormData = z.infer<typeof createRuleSchema>;

export const Route = createFileRoute('/_app/bgp/prefix-list-rules/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreatePrefixListRulePage,
});

function CreatePrefixListRulePage() {
  useDocumentTitle('Create Prefix List Rule');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { mutateAsync: createRule, isPending } = tsr.createPrefixListRule.useMutation({
    meta: { successMessage: 'Prefix list rule created' },
  });

  const { control, handleSubmit } = useForm<CreateRuleFormData>({
    resolver: zodResolver(createRuleSchema),
    defaultValues: {
      action: '',
      prefix: '',
      ge: '',
      le: '',
      sequence: '',
      prefixListId: '',
    },
  });

  const onSubmit = async (data: CreateRuleFormData) => {
    await createRule({
      body: {
        action: data.action,
        prefix: data.prefix || undefined,
        ge: data.ge ? parseInt(data.ge, 10) : undefined,
        le: data.le ? parseInt(data.le, 10) : undefined,
        sequence: parseInt(data.sequence, 10),
        prefixListId: data.prefixListId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix-list-rules'] });
    navigate({ to: '/bgp/prefix-list-rules' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Prefix List Rule Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput control={control} name="sequence" label="Sequence" description="Rule order number" />
            <FormSelect
              control={control}
              name="action"
              label="Action"
              options={[...actionOptions]}
              placeholder="Select action"
            />
            <FormInput control={control} name="prefix" label="Prefix" description="IP prefix (e.g. 10.0.0.0/8)" />
            <FormInput control={control} name="ge" label="GE" description="Minimum prefix length" />
            <FormInput control={control} name="le" label="LE" description="Maximum prefix length" />
            <PrefixListCombobox control={control} name="prefixListId" label="Prefix list" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Rule'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/bgp/prefix-list-rules' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
