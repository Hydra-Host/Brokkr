import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@repo/ui/components/button';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { tsr } from '~/lib/api';

const addSshKeySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  key: z.string().min(1, 'SSH key is required'),
});

type AddSshKeyFormData = z.infer<typeof addSshKeySchema>;

interface AddSshKeyInlineFormProps {
  onCancel: () => void;
  onSuccess: () => Promise<void> | void;
}

export function AddSshKeyInlineForm({ onCancel, onSuccess }: AddSshKeyInlineFormProps) {
  const form = useForm<AddSshKeyFormData>({
    resolver: zodResolver(addSshKeySchema),
    defaultValues: {
      name: '',
      key: '',
    },
  });

  const { mutateAsync: createSshKey, isPending } = tsr.createSshKey.useMutation({
    meta: { successMessage: 'SSH key added successfully' },
  });

  const submit = async (data: AddSshKeyFormData) => {
    await createSshKey({
      body: {
        name: data.name,
        key: data.key,
      },
    });
    await onSuccess();
  };

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
      <div className="space-y-4">
        <p className="text-lg text-teal-400">Add New SSH Key</p>
        <FormInput control={form.control} name="name" label="Name" placeholder="Give a description to your SSH key" />
        <FormTextarea
          control={form.control}
          name="key"
          label="SSH Key"
          placeholder="ssh-ed25519 AAAA... user@host"
          rows={6}
          className="font-mono"
        />
      </div>
      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <FormSubmitButton pending={isPending}>Add SSH Key</FormSubmitButton>
      </div>
    </form>
  );
}
