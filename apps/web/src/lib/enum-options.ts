import { IpxeBuildTargetSchema } from '@repo/api-client';
import type { SelectOption } from '@repo/ui/form/form-select';

type EnumLike = { readonly options: readonly string[] };

export function enumOptions(
  schema: EnumLike,
  labelOverrides: Record<string, string> = {},
): { value: string; label: string }[] {
  return schema.options.map((value) => ({ value, label: labelOverrides[value] ?? humanizeEnumValue(value) }));
}

export function humanizeEnumValue(value: string): string {
  return value
    .split('_')
    .map((token) =>
      /\d/.test(token) || (token.length <= 4 && token === token.toUpperCase())
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
    )
    .join(' ');
}

// iPXE build-target options derived from the canonical IpxeBuildTargetSchema. The leading "inherit"
// entry (value '') is worded per context, so the caller supplies its label.
export function ipxeTargetOptions(inheritLabel: string): SelectOption[] {
  // Friendly labels for the canonical targets: IPXE → "iPXE" (canonical casing) and SNPONLY → "SNP
  // Only" (humanize would otherwise yield "Snponly"). SNP stays verbatim (short all-caps acronym).
  return [
    { label: inheritLabel, value: '' },
    ...enumOptions(IpxeBuildTargetSchema, { IPXE: 'iPXE', SNPONLY: 'SNP Only' }),
  ];
}
