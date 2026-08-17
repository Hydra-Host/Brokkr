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
import { Skeleton } from '@repo/ui/components/skeleton';
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

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/contacts/create')({
  staticData: { breadcrumb: 'Create Contact' },
  component: CreateContactRoute,
});

function CreateContactRoute() {
  const params = Route.useParams();
  const { data: zoneData, isPending: isLoading } = tsr.getZoneById.useQuery({
    queryKey: ['zone', params.zoneId],
    queryData: { params: { zoneId: params.zoneId } },
  });
  const zone = zoneData?.status === 200 ? zoneData.body : null;
  const navigate = useNavigate();

  const queryClient = useQueryClient();

  useDocumentTitle('Create Contact');

  const { mutateAsync: createContact, isPending } = tsr.createZoneContact.useMutation({
    meta: { successMessage: 'Contact added' },
  });

  const form = useForm({
    resolver: zodResolver(ZoneContactInputSchema),
    defaultValues: {
      name: '',
      title: '',
      email: '',
      phone: '',
      contactType: 'Main',
      isShippingContact: false,
    },
  });

  const onClose = () => {
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  };

  const onSubmit = form.handleSubmit(async (data) => {
    await createContact({
      params: { zoneId: params.zoneId },
      body: data,
    });

    await queryClient.invalidateQueries({ queryKey: ['zones'] });
    await queryClient.invalidateQueries({ queryKey: ['zone', params.zoneId, 'contacts'] });
    navigate({
      to: '/dcim/zones/$zoneId',
      params: { zoneId: params.zoneId },
    });
  });

  if (isLoading) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[550px]">
          <Skeleton className="h-48" />
        </DialogContent>
      </Dialog>
    );
  }

  if (!zone) {
    return (
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[550px]">
          <DialogHeader>
            <DialogTitle>Zone not found</DialogTitle>
            <DialogDescription>The zone could not be found.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[550px]">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add New Contact</DialogTitle>
            <DialogDescription>Add a new contact for {zone.name}.</DialogDescription>
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
            <FormSubmitButton pending={isPending}>Add Contact</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
