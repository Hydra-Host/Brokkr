import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { useQueryClient } from '@tanstack/react-query';
import { Network, Plus, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

// Keys are interpolated verbatim into rendered netplan YAML, so mirror the API's
// BondParametersSchema key rule here rather than waiting for the 400.
const BOND_KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const bondParametersFormSchema = z
  .object({
    parameters: z.array(
      z.object({
        key: z.string().trim().regex(BOND_KEY_REGEX, 'Must be a plain identifier (letters, digits, _ and -)'),
        value: z.string().trim().min(1, 'Required'),
      }),
    ),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.parameters.forEach((param, index) => {
      if (seen.has(param.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameters', index, 'key'],
          message: 'Duplicate key',
        });
      }
      seen.add(param.key);
    });
  });

type BondParametersFormData = z.infer<typeof bondParametersFormSchema>;

export function apiToForm(bondParameters: Record<string, unknown> | null): BondParametersFormData {
  if (!bondParameters) return { parameters: [] };
  return {
    parameters: Object.entries(bondParameters).map(([key, value]) => ({
      key,
      // arrays round-trip as a comma-separated list; every other scalar stringifies
      value: Array.isArray(value) ? value.join(', ') : String(value),
    })),
  };
}

/** No rows → null; an empty object is rejected. `stored` preserves array types: an array-valued key is edited as comma text and split back on save, so netplan still gets a sequence. */
export function formToPayload(
  formData: BondParametersFormData,
  stored: Record<string, unknown> | null,
): Record<string, string | string[]> | null {
  if (formData.parameters.length === 0) return null;
  return Object.fromEntries(
    formData.parameters.map((param) => {
      const key = param.key.trim();
      const value = param.value.trim();
      if (!Array.isArray(stored?.[key])) return [key, value];
      return [
        key,
        value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      ];
    }),
  );
}

export function PrefixBondParametersCard({
  prefixId,
  bondParameters,
}: {
  prefixId: string;
  bondParameters: Record<string, unknown> | null;
}) {
  const queryClient = useQueryClient();

  const updateMutation = tsr.updatePrefix.useMutation({
    meta: { successMessage: 'Bond attributes updated' },
  });

  const {
    control,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm<BondParametersFormData>({
    resolver: zodResolver(bondParametersFormSchema),
    defaultValues: apiToForm(bondParameters),
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'parameters' });

  useEffect(() => {
    reset(apiToForm(bondParameters));
  }, [bondParameters, reset]);

  const onSubmit = async (formData: BondParametersFormData) => {
    await updateMutation.mutateAsync({
      params: { id: prefixId },
      body: { bondParameters: formToPayload(formData, bondParameters) },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix', prefixId] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          Bond Attributes
        </CardTitle>
        <CardDescription>
          Netplan bond parameters emitted for interfaces on this prefix. Setting any attribute is what makes rendered
          netplan bond a device&apos;s NICs on this prefix at all — clearing them all disables bonding.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Parameters</span>
              <Button type="button" variant="outline" size="sm" onClick={() => append({ key: '', value: '' })}>
                <Plus className="mr-2 h-4 w-4" />
                Add attribute
              </Button>
            </div>
            {fields.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No bond attributes. Devices on this prefix get individually addressed NICs rather than a bond.
              </p>
            )}
            {fields.length > 0 && (
              <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-3">
                <span className="text-text-label font-mono text-sm font-medium tracking-wide uppercase">Attribute</span>
                <span className="text-text-label font-mono text-sm font-medium tracking-wide uppercase">Value</span>
                <span className="w-10" aria-hidden />
              </div>
            )}
            {fields.map((field, index) => (
              <div key={field.id} className="grid grid-cols-[1fr_1fr_auto] items-start gap-3">
                <FormInput
                  control={control}
                  name={`parameters.${index}.key`}
                  label="Attribute"
                  hideLabel
                  placeholder="e.g. mode"
                />
                <FormInput
                  control={control}
                  name={`parameters.${index}.value`}
                  label="Value"
                  hideLabel
                  placeholder="e.g. 802.3ad"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(index)}
                  aria-label="Remove bond attribute"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="pt-2">
            <Button type="submit" disabled={!isDirty || updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Bond Attributes'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
