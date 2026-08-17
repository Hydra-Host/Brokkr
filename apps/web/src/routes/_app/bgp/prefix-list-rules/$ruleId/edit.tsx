import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const actionOptions = [
  { label: 'Permit', value: 'permit' },
  { label: 'Deny', value: 'deny' },
] as const;

const editRuleSchema = z.object({
  action: z.string().min(1, 'Action is required'),
  prefix: z.string(),
  ge: z.string(),
  le: z.string(),
  sequence: z.string().min(1, 'Sequence is required'),
});

type EditRuleFormData = z.infer<typeof editRuleSchema>;

export const Route = createFileRoute('/_app/bgp/prefix-list-rules/$ruleId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditPrefixListRulePage,
});

function EditPrefixListRulePage() {
  const { ruleId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPrefixListRule.useQuery({
    queryKey: ['prefix-list-rule', ruleId],
    queryData: { params: { id: ruleId } },
  });

  const updateMutation = tsr.updatePrefixListRule.useMutation({
    meta: { successMessage: 'Prefix list rule updated' },
  });

  const rule = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditRuleFormData>({
    resolver: zodResolver(editRuleSchema),
    defaultValues: { action: '', prefix: '', ge: '', le: '', sequence: '' },
  });

  useEffect(() => {
    if (rule) {
      reset({
        action: rule.action,
        prefix: rule.prefix ?? '',
        ge: rule.ge != null ? String(rule.ge) : '',
        le: rule.le != null ? String(rule.le) : '',
        sequence: String(rule.sequence),
      });
    }
  }, [rule, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!rule) return null;

  const onSubmit = async (formData: EditRuleFormData) => {
    await updateMutation.mutateAsync({
      params: { id: ruleId },
      body: {
        action: formData.action,
        prefix: formData.prefix || undefined,
        ge: formData.ge ? parseInt(formData.ge, 10) : undefined,
        le: formData.le ? parseInt(formData.le, 10) : undefined,
        sequence: parseInt(formData.sequence, 10),
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix-list-rules'] });
    await queryClient.invalidateQueries({ queryKey: ['prefix-list-rule', ruleId] });
    navigate({ to: '/bgp/prefix-list-rules/$ruleId', params: { ruleId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Prefix List Rule</CardTitle>
        <CardDescription>Update details for rule #{rule.sequence}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/bgp/prefix-list-rules/$ruleId', params: { ruleId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
