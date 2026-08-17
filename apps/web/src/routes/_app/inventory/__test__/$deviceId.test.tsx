import { type CustomizationLayer } from '@repo/api-client';
import { CustomizationLayers, type CustomizationLayersData } from '@repo/ui/provision/customization-layers';
import { render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import {
  baseLayersToOsOptions,
  emptyCustomizations,
  flattenCustomizationsForSubmit,
} from '../../../../lib/provision-customizations';

function option(value: string, label: string) {
  return { value, label, availability: null, relations: [], hardwareCompatibility: null };
}

function layer(
  slug: string,
  selectionType: CustomizationLayer['selectionType'],
  opts: Array<{ value: string; label: string }> = [],
): CustomizationLayer {
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    selectionType,
    options: opts.map((o) => option(o.value, o.label)),
  };
}

const catalog: Record<string, CustomizationLayer[]> = {
  'ubuntu-noble-vanilla': [
    layer('gpuDriver', 'SINGLE_SELECT', [
      { value: 'nvidia-driver-580', label: 'Driver 580' },
      { value: 'nvidia-driver-595', label: 'Driver 595' },
    ]),
    layer('gpuFramework', 'SINGLE_SELECT', [
      { value: 'cuda-12-8', label: 'CUDA 12.8' },
      { value: 'cuda-13-1', label: 'CUDA 13.1' },
    ]),
    layer('miscSoftware', 'MULTI_SELECT', [
      { value: 'docker', label: 'Docker' },
      { value: 'ollama', label: 'Ollama' },
    ]),
  ],
  'ubuntu-jammy-vanilla': [
    layer('gpuDriver', 'SINGLE_SELECT', [{ value: 'nvidia-driver-580', label: 'Driver 580' }]),
    layer('tee', 'SINGLE_SELECT', [{ value: 'tee-setup', label: 'TEE Setup' }]),
  ],
};

interface TestFormValues {
  operatingSystem: string;
  customizations: Record<string, string | string[]>;
}

function CustomizationLayersHarness({
  initialOs,
  availableComponentLayersByBase,
}: {
  initialOs: string;
  availableComponentLayersByBase: Record<string, CustomizationLayer[]>;
}) {
  const form = useForm<TestFormValues>({
    defaultValues: {
      operatingSystem: initialOs,
      customizations: { ...emptyCustomizations(availableComponentLayersByBase) },
    },
  });

  const operatingSystem = form.watch('operatingSystem');
  const layers = operatingSystem ? availableComponentLayersByBase[operatingSystem] : undefined;
  const customizationsData: CustomizationLayersData | null = layers && layers.length > 0 ? { layers } : null;

  if (!customizationsData) return null;

  return (
    <CustomizationLayers
      data={customizationsData}
      control={form.control}
      setValue={form.setValue}
      getValues={form.getValues}
      osFieldName="operatingSystem"
      customizationsFieldName="customizations"
      gpuModel="NVIDIA H100"
    />
  );
}

describe('InventoryDevicePage customization form wiring', () => {
  describe('CustomizationLayers renders for an OS with component layers', () => {
    it('renders the customization picker for an OS with layers', () => {
      render(<CustomizationLayersHarness initialOs="ubuntu-noble-vanilla" availableComponentLayersByBase={catalog} />);

      expect(screen.getByText('OS Customizations')).toBeInTheDocument();
      expect(screen.getByText('GpuDriver')).toBeInTheDocument();
      expect(screen.getByText('GpuFramework')).toBeInTheDocument();
      expect(screen.getByText('MiscSoftware')).toBeInTheDocument();
    });

    it('does not render customization picker when OS has no component layers', () => {
      const emptyCatalog: Record<string, CustomizationLayer[]> = { 'debian-bullseye': [] };
      render(<CustomizationLayersHarness initialOs="debian-bullseye" availableComponentLayersByBase={emptyCatalog} />);

      expect(screen.queryByText('OS Customizations')).not.toBeInTheDocument();
    });
  });

  describe('submit path — flattenCustomizationsForSubmit (what provisionDevice receives)', () => {
    it('drops empty groups and keeps populated single/multi selections', () => {
      const values: TestFormValues['customizations'] = {
        gpuDriver: 'nvidia-driver-580',
        gpuFramework: '',
        miscSoftware: ['docker', 'ollama'],
        tee: '',
      };
      expect(flattenCustomizationsForSubmit(values)).toEqual({
        gpuDriver: 'nvidia-driver-580',
        miscSoftware: ['docker', 'ollama'],
      });
    });

    it('returns null when nothing is selected', () => {
      expect(flattenCustomizationsForSubmit(emptyCustomizations(catalog))).toBeNull();
    });

    it('reset-then-repopulate: only layers selected after the OS-change reset survive flattening', () => {
      const afterReset = { ...emptyCustomizations(catalog), gpuDriver: 'nvidia-driver-595' };
      expect(flattenCustomizationsForSubmit(afterReset)).toEqual({ gpuDriver: 'nvidia-driver-595' });
    });
  });

  describe('OS-change reset — emptyCustomizations', () => {
    it('covers every group slug across all bases, with type-correct empties', () => {
      const defaults = emptyCustomizations(catalog);

      expect(defaults).toHaveProperty('gpuDriver');
      expect(defaults).toHaveProperty('gpuFramework');
      expect(defaults).toHaveProperty('miscSoftware');
      expect(defaults).toHaveProperty('tee');

      expect(defaults.gpuDriver).toBe('');
      expect(defaults.gpuFramework).toBe('');
      expect(defaults.tee).toBe('');
      expect(defaults.miscSoftware).toEqual([]);
    });

    it('each emptyCustomizations() call returns fresh unaliased arrays for MULTI_SELECT groups', () => {
      const a = emptyCustomizations(catalog);
      const b = emptyCustomizations(catalog);
      (a.miscSoftware as string[]).push('docker');
      expect(b.miscSoftware).toHaveLength(0);
    });
  });

  describe('empty-base-layers gating — baseLayersToOsOptions (drives hasNoOs)', () => {
    it('yields no options for an empty availableBaseLayers (→ hasNoOs banner + disabled OS select & submit)', () => {
      const osOptions = baseLayersToOsOptions([]);
      expect(osOptions).toEqual([]);
    });

    it('maps base layers to name-sorted {label, value} options when present', () => {
      const osOptions = baseLayersToOsOptions([
        { name: 'Ubuntu 24.04', slug: 'ubuntu-noble-vanilla' },
        { name: 'Debian 12', slug: 'debian-bookworm-vanilla' },
      ]);
      expect(osOptions).toEqual([
        { label: 'Debian 12', value: 'debian-bookworm-vanilla' },
        { label: 'Ubuntu 24.04', value: 'ubuntu-noble-vanilla' },
      ]);
    });
  });
});
