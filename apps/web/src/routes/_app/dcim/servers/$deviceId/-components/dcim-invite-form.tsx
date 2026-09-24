import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, AlertDescription } from '@repo/ui/components/alert';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Separator } from '@repo/ui/components/separator';
import { FormDatePicker } from '@repo/ui/form/form-datepicker';
import { FormInput } from '@repo/ui/form/form-input';
import { FormMoneyInput } from '@repo/ui/form/form-money-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import {
  type NoticePeriodUnit,
  BillingFrequency,
  CONTRACT_TYPE_OPTIONS,
  ContractType,
  MAX_INTERRUPTIBLE_NOTICE_PERIOD_MS,
  NOTICE_PERIOD_UNIT_OPTIONS,
  SELECTABLE_CONTRACT_TYPES,
  calculateNoticePeriodMs,
  formatBillingFrequencyCopy,
  getBillingFrequencyHours,
  parseNoticePeriodMs,
  scalePricesForFrequencyChange,
} from '@repo/utils';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

const BILLING_FREQUENCY_OPTIONS = [
  { label: 'Weekly', value: BillingFrequency.WEEKLY },
  { label: 'Monthly', value: BillingFrequency.MONTHLY },
];

const DEFAULT_EXPIRY_DAYS = 2;

function getDefaultExpiryDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_EXPIRY_DAYS);
  return d.toISOString();
}

const formSchema = z
  .object({
    inviteeEmail: z.string().email('Valid email is required'),
    contractType: z.enum(SELECTABLE_CONTRACT_TYPES),
    billingFrequency: z.string().min(1, 'Billing frequency is required'),
    price: z.coerce.number({ required_error: 'Required', invalid_type_error: 'Must be a number' }),
    interruptibleNoticePeriodValue: z.coerce.number().optional(),
    interruptibleNoticePeriodUnit: z.string().optional(),
    dateExpires: z.string().min(1, 'Expiration date is required'),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.contractType === ContractType.INTERRUPTIBLE) {
        if (!data.interruptibleNoticePeriodValue || data.interruptibleNoticePeriodValue <= 0) return false;
        const ms = calculateNoticePeriodMs(
          data.interruptibleNoticePeriodValue,
          (data.interruptibleNoticePeriodUnit as NoticePeriodUnit) || 'hours',
        );
        return ms <= MAX_INTERRUPTIBLE_NOTICE_PERIOD_MS;
      }
      return true;
    },
    {
      message: 'Notice period is required and must be at most 7 days',
      path: ['interruptibleNoticePeriodValue'],
    },
  );

export type DcimInviteFormValues = z.input<typeof formSchema>;

interface ExistingInvite {
  id: string;
  inviteeEmail?: string | null;
  billingFrequency: string;
  price: number | null;
  interruptibleNoticePeriod?: number | null;
  dateExpires?: Date | string | null;
  notes?: string | null;
}

interface DcimInviteFormProps {
  mode: 'create' | 'edit';
  invite?: ExistingInvite;
  gpuCount: number;
  isInterruptibleOnly?: boolean;
  onSubmit: (data: DcimInviteFormValues) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
}

export function DcimInviteForm({
  mode,
  invite,
  gpuCount,
  isInterruptibleOnly = false,
  onSubmit,
  onCancel,
  isPending,
}: DcimInviteFormProps) {
  const isEdit = mode === 'edit';

  const noticePeriodDefaults = useMemo(() => {
    if (invite?.interruptibleNoticePeriod) {
      return parseNoticePeriodMs(invite.interruptibleNoticePeriod);
    }
    return { value: 1, unit: 'hours' as NoticePeriodUnit };
  }, [invite?.interruptibleNoticePeriod]);

  const form = useForm<DcimInviteFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: invite
      ? {
          inviteeEmail: invite.inviteeEmail ?? '',
          contractType: ContractType.RESERVED_ROLLING,
          billingFrequency: invite.billingFrequency,
          price: invite.price ?? 0,
          interruptibleNoticePeriodValue: noticePeriodDefaults.value,
          interruptibleNoticePeriodUnit: noticePeriodDefaults.unit,
          dateExpires: invite.dateExpires ? new Date(invite.dateExpires).toISOString() : getDefaultExpiryDate(),
          notes: invite.notes ?? '',
        }
      : {
          inviteeEmail: '',
          contractType: ContractType.RESERVED_ROLLING,
          billingFrequency: BillingFrequency.WEEKLY,
          price: 0,
          interruptibleNoticePeriodValue: 1,
          interruptibleNoticePeriodUnit: 'hours',
          dateExpires: getDefaultExpiryDate(),
          notes: '',
        },
  });

  const { control, setValue, getValues } = form;

  const contractType = useWatch({ control, name: 'contractType' });
  const billingFrequency = useWatch({ control, name: 'billingFrequency' });
  const isInterruptible = contractType === ContractType.INTERRUPTIBLE;

  const prevFrequencyRef = useRef(billingFrequency);

  useEffect(() => {
    const prev = prevFrequencyRef.current;
    if (prev && prev !== billingFrequency && prev !== '' && billingFrequency !== '') {
      const { price } = getValues();
      const scaled = scalePricesForFrequencyChange(
        price,
        0,
        prev as BillingFrequency,
        billingFrequency as BillingFrequency,
      );
      setValue('price', scaled.buyerPrice);
    }
    prevFrequencyRef.current = billingFrequency;
  }, [billingFrequency, getValues, setValue]);

  const watchedPrice = useWatch({ control, name: 'price' });
  const periodHours = getBillingFrequencyHours(billingFrequency);

  const updatePrice = useCallback((newCents: number) => setValue('price', newCents), [setValue]);

  return (
    <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-6">
      {isInterruptibleOnly && (
        <Alert variant="warning">
          <AlertDescription>
            This device is interruptible-only and cannot use Reserved Rolling invites until commerce billing is ready.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Invitee</CardTitle>
          <CardDescription>
            {isEdit ? 'The invitee cannot be changed after creation.' : 'Enter the email of the customer to invite.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm">
            <FormInput
              control={control}
              name="inviteeEmail"
              label="Email Address"
              type="email"
              placeholder="customer@example.com"
              disabled={isEdit}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contract Details</CardTitle>
          <CardDescription>Configure the contract type and billing frequency.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FormSelect
              control={control}
              name="contractType"
              label="Contract Type"
              options={CONTRACT_TYPE_OPTIONS}
              placeholder="Select contract type"
            />

            <FormSelect
              control={control}
              name="billingFrequency"
              label="Billing Frequency"
              options={BILLING_FREQUENCY_OPTIONS}
              placeholder="Select frequency..."
            />
          </div>

          {isInterruptible && (
            <>
              <Separator />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <FormInput
                  control={control}
                  name="interruptibleNoticePeriodValue"
                  label="Notice Period"
                  type="number"
                  min={1}
                  placeholder="1"
                />
                <FormSelect
                  control={control}
                  name="interruptibleNoticePeriodUnit"
                  label="Unit"
                  options={NOTICE_PERIOD_UNIT_OPTIONS}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pricing</CardTitle>
          <CardDescription>Set the price per billing period.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <FormMoneyInput
              control={control}
              name="price"
              label="GPU/Hour"
              disabled={!gpuCount}
              externalValue={gpuCount && periodHours ? watchedPrice / (periodHours * gpuCount) : 0}
              onValueChange={(cents) => updatePrice(cents * periodHours * gpuCount)}
            />
            <FormMoneyInput
              control={control}
              name="price"
              label="Server/Hour"
              externalValue={periodHours ? watchedPrice / periodHours : 0}
              onValueChange={(cents) => updatePrice(cents * periodHours)}
            />
            <FormMoneyInput
              control={control}
              name="price"
              label={formatBillingFrequencyCopy(billingFrequency) || 'Server/Period'}
              onValueChange={(val) => updatePrice(val)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expiration & Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm">
            <FormDatePicker control={control} name="dateExpires" label="Expiration Date" minDate={new Date()} />
          </div>

          <FormTextarea
            control={control}
            name="notes"
            label="Notes"
            placeholder="Optional internal notes about this invite..."
            rows={3}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <FormSubmitButton pending={isPending} disabled={isInterruptibleOnly}>
          {isEdit ? 'Save Changes' : 'Create Invite'}
        </FormSubmitButton>
      </div>
    </form>
  );
}
