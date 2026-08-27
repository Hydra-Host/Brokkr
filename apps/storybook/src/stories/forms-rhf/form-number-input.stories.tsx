import { zodResolver } from '@hookform/resolvers/zod';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { z } from 'zod';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormNumberInput',
  component: FormNumberInput,
  parameters: {
    docs: {
      description: {
        component:
          'Numeric input bound via `control`. An empty input writes `undefined` to the form (not `NaN`); otherwise the field holds `valueAsNumber`.',
      },
    },
  },
} satisfies Meta<typeof FormNumberInput>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ vcpus: 8 }}>
      {({ control }) => (
        <FormNumberInput
          control={control}
          name="vcpus"
          label="vCPU cores"
          description="Cores allocated to the instance."
        />
      )}
    </StoryForm>
  ),
};

export const MinMaxStep: Story = {
  render: () => (
    <StoryForm defaultValues={{ memoryGb: 64 }}>
      {({ control }) => (
        <FormNumberInput
          control={control}
          name="memoryGb"
          label="Memory (GB)"
          description="Steppers move in 16 GB increments between 16 and 512."
          min={16}
          max={512}
          step={16}
        />
      )}
    </StoryForm>
  ),
};

const replicaSchema = z.object({
  replicas: z
    .number({ required_error: 'Replica count is required' })
    .int('Whole numbers only')
    .min(1, 'At least 1 replica')
    .max(16, 'At most 16 replicas'),
});

export const WithValidation: Story = {
  render: () => (
    <StoryForm defaultValues={{ replicas: 0 }} resolver={zodResolver(replicaSchema)}>
      {({ control }) => (
        <>
          <FormNumberInput
            control={control}
            name="replicas"
            label="Replicas"
            description="Clear the field or enter 0 or 3.5 to trigger the zod errors."
          />
          <FormSubmitButton>Scale</FormSubmitButton>
        </>
      )}
    </StoryForm>
  ),
};

export const ComposedWatchedValue: Story = {
  render: () => (
    <StoryForm defaultValues={{ nodes: 3, gpusPerNode: 8 }}>
      {(form) => (
        <>
          <div className="grid grid-cols-2 gap-4">
            <FormNumberInput control={form.control} name="nodes" label="Nodes" min={1} />
            <FormNumberInput control={form.control} name="gpusPerNode" label="GPUs per node" min={1} max={8} />
          </div>
          <p className="text-text-muted font-mono text-xs">
            total GPUs: {(form.watch('nodes') ?? 0) * (form.watch('gpusPerNode') ?? 0)}
          </p>
        </>
      )}
    </StoryForm>
  ),
};
