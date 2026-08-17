import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';

const SSH_KEYS_KEY = ['ssh-keys'] as const;

const createSshKeySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  key: z.string().min(1, 'SSH key is required'),
});

type CreateSshKeyFormData = z.infer<typeof createSshKeySchema>;

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/_app/account/ssh-keys/create')({
  staticData: { breadcrumb: 'Add Key' },
  validateSearch: searchSchema,
  component: CreateSshKeyPage,
});

function CreateSshKeyPage() {
  useDocumentTitle('Add SSH Key');
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { redirect: redirectTo } = Route.useSearch();

  const { mutateAsync: createSshKey, isPending } = tsr.createSshKey.useMutation({
    meta: { successMessage: 'SSH key added successfully' },
  });

  const form = useForm<CreateSshKeyFormData>({
    resolver: zodResolver(createSshKeySchema),
    defaultValues: {
      name: '',
      key: '',
    },
  });

  const handleCancel = () => {
    if (redirectTo) {
      navigate({ to: redirectTo });
    } else {
      navigate({ to: '/account/ssh-keys' });
    }
  };

  const onSubmit = async (data: CreateSshKeyFormData) => {
    await createSshKey({ body: { name: data.name, key: data.key } });

    queryClient.removeQueries({ queryKey: SSH_KEYS_KEY });
    queryClient.removeQueries({ queryKey: ['organization-ssh-keys'] });
    await router.invalidate();

    if (redirectTo) {
      navigate({ to: redirectTo });
    } else {
      navigate({ to: '/account/ssh-keys' });
    }
  };

  return (
    <Card>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <CardHeader>
          <CardTitle>Add SSH Key</CardTitle>
          <CardDescription>
            The key will be associated with your user in your currently selected organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-lg">
            <FormInput
              control={form.control}
              name="name"
              label="Name"
              placeholder="Give a name to your key"
              autoFocus
            />
          </div>
          <div className="max-w-2xl">
            <FormTextarea
              control={form.control}
              name="key"
              label="Key"
              placeholder="ssh-ed25519 AAAA... user@host"
              rows={6}
              className="font-mono"
            />
          </div>
        </CardContent>
        <CardFooter className="flex gap-2 border-t px-4 py-4">
          <FormSubmitButton pending={isPending}>Add SSH Key</FormSubmitButton>
          <Button type="button" variant="outline" onClick={handleCancel} disabled={isPending}>
            Cancel
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
