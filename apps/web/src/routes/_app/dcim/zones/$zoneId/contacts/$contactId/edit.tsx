import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';

import { ZoneContactInputSchema } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormPhoneInput } from '@repo/ui/form/form-phone-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';

const CONTACT_TYPE_OPTIONS = [
  { label: 'Main', value: 'Main' },
  { label: 'Technical', value: 'Technical' },
];

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/contacts/$contactId/edit')({
  staticData: {
    breadcrumb: (data) => {
      if (data && typeof data === 'object' && 'name' in data && typeof data.name === 'string') {
        return data.name;
      }
      return 'Edit Contact';
    },
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['zone', params.zoneId, 'contact', params.contactId],
      queryFn: () =>
        tsr.getZoneContact.query({
          params: { zoneId: params.zoneId, contactId: params.contactId },
        }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load contact');
    }

    return response.body;
  },
  component: EditContactRoute,
});

function EditContactRoute() {
  const contact = Route.useLoaderData();
  const params = Route.useParams();
  const navigate = useNavigate();

  const queryClient = useQueryClient();

  useDocumentTitle(`Edit ${contact.name}`);

  const { mutateAsync: updateContact, isPending } = tsr.updateZoneContact.useMutation({
    meta: { successMessage: 'Contact updated' },
  });

  const form = useForm({
    resolver: zodResolver(ZoneContactInputSchema),
    defaultValues: {
      name: contact.name,
      title: contact.title,
      email: contact.email,
      phone: contact.phone,
      contactType: contact.contactType,
      isShippingContact: contact.isShippingContact,
    },
  });

  const onClose = () => {
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  };

  const onSubmit = form.handleSubmit(async (data) => {
    await updateContact({
      params: {
        zoneId: params.zoneId,
        contactId: params.contactId,
      },
      body: data,
    });

    await queryClient.invalidateQueries({ queryKey: ['zones'] });
    await queryClient.invalidateQueries({ queryKey: ['zone', params.zoneId, 'contacts'] });
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  });

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[550px]">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Contact: {contact.name}</DialogTitle>
            <DialogDescription>Update the details for {contact.name}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <FormInput control={form.control} name="name" label="Full Name" placeholder="John Doe" autoFocus />
              <FormInput control={form.control} name="title" label="Title" placeholder="Site Manager" />
            </div>
            <FormSelect
              control={form.control}
              name="contactType"
              label="Contact Type"
              options={CONTACT_TYPE_OPTIONS}
              placeholder="Select contact type"
            />
            <FormInput control={form.control} name="email" label="Email" placeholder="john@example.com" type="email" />
            <FormPhoneInput control={form.control} name="phone" label="Phone" defaultCountry="US" />
            <FormCheckbox control={form.control} name="isShippingContact" label="Use as shipping contact" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Update Contact</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
