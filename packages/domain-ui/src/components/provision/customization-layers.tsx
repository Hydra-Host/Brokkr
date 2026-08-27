import { type CustomizationLayer, type CustomizationOption } from '@repo/api-client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import { FormSelect, type SelectOption } from '@repo/ui/form/form-select';
import { compareCustomizationLayers, parseGpuFamily } from '@repo/utils';
import { useCallback, useMemo } from 'react';
import {
  useWatch,
  type Control,
  type FieldPath,
  type FieldValues,
  type PathValue,
  type UseFormGetValues,
  type UseFormSetValue,
} from 'react-hook-form';

export type CustomizationLayersData = { layers: CustomizationLayer[] };

type CustomizationValues = Record<string, string | string[] | undefined>;

function parseOsSlug(slug: string): { distro: string; codename: string; variant: string } | null {
  const parts = slug.split('-');
  if (parts.length < 3) return null;
  return {
    distro: parts[0],
    codename: parts[1],
    variant: parts.slice(2).join('-'),
  };
}

function isOptionCompatibleWithHardware(option: CustomizationOption, gpuFamily: string | null): boolean {
  if (!gpuFamily) return true;
  if (!option.hardwareCompatibility) return true;
  return option.hardwareCompatibility.gpuFamilies.includes(gpuFamily);
}

function isOptionAvailableForOs(option: CustomizationOption, osSlug: string): boolean {
  if (!option.availability) return true;
  const parsed = parseOsSlug(osSlug);
  if (!parsed) return true;

  return option.availability.some((filter) => {
    if (filter.os_distro && filter.os_distro !== parsed.distro) return false;
    if (filter.os_codename && filter.os_codename !== parsed.codename) return false;
    if (filter.os_variant && filter.os_variant !== parsed.variant) return false;
    return true;
  });
}

function getReverseRequiresConstraint(
  layer: CustomizationLayer,
  allLayers: CustomizationLayer[],
  values: CustomizationValues,
): Set<string> | null {
  const allowed = new Set<string>();
  let hasConstraint = false;

  for (const otherLayer of allLayers) {
    if (otherLayer.slug === layer.slug) continue;
    const selection = values[otherLayer.slug];
    const selectedSlugs = Array.isArray(selection) ? selection : selection ? [selection] : [];

    for (const slug of selectedSlugs) {
      const option = otherLayer.options.find((o) => o.value === slug);
      if (!option) continue;

      const pointingHere = option.relations.filter(
        (r) => r.type === 'REQUIRES' && layer.options.some((lo) => lo.value === r.relatedOptionValue),
      );

      if (pointingHere.length > 0) {
        hasConstraint = true;
        for (const rel of pointingHere) {
          allowed.add(rel.relatedOptionValue);
        }
      }
    }
  }

  return hasConstraint ? allowed : null;
}

// Forward-REQUIRES: an option's OR-grouped REQUIRES must be satisfied by an already-selected value in the related layer; symmetric with getReverseRequiresConstraint.
function isOptionForwardCompatible(
  opt: CustomizationOption,
  allLayers: CustomizationLayer[],
  values: CustomizationValues,
): boolean {
  const groups = new Map<string, Set<string>>();
  for (const rel of opt.relations) {
    if (rel.type !== 'REQUIRES' || !rel.groupId) continue;
    const set = groups.get(rel.groupId) ?? new Set<string>();
    set.add(rel.relatedOptionValue);
    groups.set(rel.groupId, set);
  }

  for (const relatedSet of groups.values()) {
    const relatedLayer = allLayers.find((l) => l.options.some((o) => relatedSet.has(o.value)));
    if (!relatedLayer) continue;

    const selection = values[relatedLayer.slug];
    const selectedSlugs = Array.isArray(selection) ? selection : selection ? [selection] : [];

    if (selectedSlugs.length === 0) continue;

    if (!selectedSlugs.some((s) => relatedSet.has(s))) return false;
  }

  return true;
}

function getAvailableOptions(
  layer: CustomizationLayer,
  allLayers: CustomizationLayer[],
  osSlug: string,
  values: CustomizationValues,
  gpuFamily: string | null,
): CustomizationOption[] {
  const reverseConstraint = getReverseRequiresConstraint(layer, allLayers, values);

  return layer.options.filter((opt) => {
    if (!isOptionAvailableForOs(opt, osSlug)) return false;
    if (!isOptionCompatibleWithHardware(opt, gpuFamily)) return false;
    if (reverseConstraint && !reverseConstraint.has(opt.value)) return false;
    if (!isOptionForwardCompatible(opt, allLayers, values)) return false;
    return true;
  });
}

const DRIVER_CUDA_COMPAT = [
  { cuda: '11.8', driver: '535' },
  { cuda: '12.1', driver: '535' },
  { cuda: '12.2', driver: '535' },
  { cuda: '12.4', driver: '570' },
  { cuda: '12.6', driver: '570' },
  { cuda: '12.8', driver: '570' },
  { cuda: '13.0', driver: '580' },
  { cuda: '13.1', driver: '595' },
  { cuda: '13.2', driver: '595' },
] as const;

function DriverCudaReferenceTable({ osSlug }: { osSlug: string }) {
  const parsed = parseOsSlug(osSlug);
  const isNoble = parsed?.codename === 'noble';

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Compatibility Reference</p>
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>CUDA Version</TableHead>
            <TableHead>Minimum Driver Version</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {DRIVER_CUDA_COMPAT.map((row) => (
            <TableRow key={`${row.cuda}-${row.driver}`}>
              <TableCell>
                {row.cuda}
                {isNoble && row.cuda === '12.2' ? ' *' : ''}
              </TableCell>
              <TableCell>
                {row.driver}
                {isNoble && row.driver === '535' ? ' †' : ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isNoble && (
        <div className="text-muted-foreground space-y-0.5 text-xs italic">
          <p>* CUDA 12.2 not available for Ubuntu 24.04 (Noble)</p>
          <p>† Driver 535 not available on Noble — pick a higher driver for CUDA 11.8 / 12.1</p>
        </div>
      )}
    </div>
  );
}

interface LayerFieldProps<T extends FieldValues> {
  layer: CustomizationLayer;
  available: CustomizationOption[];
  control: Control<T>;
  fieldName: FieldPath<T>;
  disabled?: boolean;
  onChange: () => void;
}

function LayerField<T extends FieldValues>({
  layer,
  available,
  control,
  fieldName,
  disabled,
  onChange,
}: LayerFieldProps<T>) {
  const options: SelectOption[] = available.map((opt) => ({ label: opt.label, value: opt.value }));
  const placeholder = `Select ${layer.name.toLowerCase()}`;
  const isDisabled = disabled || available.length === 0;
  const description = available.length === 0 ? 'No options available for the current configuration' : undefined;

  if (layer.selectionType === 'SINGLE_SELECT') {
    return (
      <FormSelect
        control={control}
        name={fieldName}
        label={layer.name}
        placeholder={placeholder}
        options={options}
        clearable
        disabled={isDisabled}
        description={description}
        onValueChange={onChange}
      />
    );
  }

  return (
    <FormMultiSelect
      control={control}
      name={fieldName}
      label={layer.name}
      placeholder={placeholder}
      options={options}
      disabled={isDisabled}
      onValueChange={onChange}
    />
  );
}

interface CustomizationLayersProps<T extends FieldValues> {
  data: CustomizationLayersData;
  control: Control<T>;
  setValue: UseFormSetValue<T>;
  getValues: UseFormGetValues<T>;
  osFieldName: FieldPath<T>;
  customizationsFieldName: FieldPath<T>;
  gpuModel?: string | null;
  disabled?: boolean;
}

export function CustomizationLayers<T extends FieldValues>({
  data,
  control,
  setValue,
  getValues,
  osFieldName,
  customizationsFieldName,
  gpuModel,
  disabled,
}: CustomizationLayersProps<T>) {
  const watchedOsSlug = useWatch({ control, name: osFieldName }) as string | undefined;
  const watchedCustomizations = useWatch({ control, name: customizationsFieldName }) as CustomizationValues | undefined;

  const osSlug = watchedOsSlug ?? '';
  const customizations = useMemo<CustomizationValues>(() => watchedCustomizations ?? {}, [watchedCustomizations]);

  const gpuFamily = useMemo(() => parseGpuFamily(gpuModel), [gpuModel]);

  const sortedLayers = useMemo(() => [...data.layers].sort(compareCustomizationLayers), [data.layers]);

  const layerOptions = useMemo(() => {
    const result: Record<string, CustomizationOption[]> = {};
    for (const layer of sortedLayers) {
      result[layer.slug] = getAvailableOptions(layer, sortedLayers, osSlug, customizations, gpuFamily);
    }
    return result;
  }, [sortedLayers, osSlug, customizations, gpuFamily]);

  // getValues sees the in-flight field.onChange; loop until stable so chained REQUIRES cascade — the changed layer is skipped only on the first pass since clearing a sibling can invalidate it too.
  const handleLayerChange = useCallback(
    (changedSlug: string) => {
      let pending = (getValues(customizationsFieldName) ?? {}) as CustomizationValues;
      let changed = true;
      let firstPass = true;

      while (changed) {
        changed = false;
        for (const sibling of sortedLayers) {
          if (firstPass && sibling.slug === changedSlug) continue;
          const allowed = new Set(
            getAvailableOptions(sibling, sortedLayers, osSlug, pending, gpuFamily).map((o) => o.value),
          );
          const current = pending[sibling.slug];
          const fieldName = `${customizationsFieldName}.${sibling.slug}` as FieldPath<T>;

          if (sibling.selectionType === 'SINGLE_SELECT') {
            if (typeof current === 'string' && current && !allowed.has(current)) {
              setValue(fieldName, '' as PathValue<T, FieldPath<T>>);
              pending = { ...pending, [sibling.slug]: '' };
              changed = true;
            }
            continue;
          }

          if (Array.isArray(current) && current.length > 0) {
            const filtered = current.filter((v) => allowed.has(v));
            if (filtered.length !== current.length) {
              setValue(fieldName, filtered as PathValue<T, FieldPath<T>>);
              pending = { ...pending, [sibling.slug]: filtered };
              changed = true;
            }
          }
        }
        firstPass = false;
      }
    },
    [getValues, sortedLayers, osSlug, gpuFamily, customizationsFieldName, setValue],
  );

  if (!sortedLayers.length) return null;

  const hasGpuLayers = sortedLayers.some((l) => l.slug === 'gpuDriver' || l.slug === 'gpuFramework');

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <div className="space-y-6">
        <div>
          <h3 className="text-sm leading-6 font-medium">OS Customizations</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Configure drivers, toolkits, and software to be installed during provisioning.
          </p>
        </div>

        {sortedLayers.map((layer) => (
          <LayerField
            key={layer.slug}
            layer={layer}
            available={layerOptions[layer.slug] ?? []}
            control={control}
            fieldName={`${customizationsFieldName}.${layer.slug}` as FieldPath<T>}
            disabled={disabled}
            onChange={() => handleLayerChange(layer.slug)}
          />
        ))}
      </div>

      {hasGpuLayers && (
        <div className="mt-8 md:mt-0">
          <DriverCudaReferenceTable osSlug={osSlug} />
        </div>
      )}
    </div>
  );
}
