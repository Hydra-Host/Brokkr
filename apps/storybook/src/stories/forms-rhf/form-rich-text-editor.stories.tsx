import { FormRichTextEditor } from '@repo/ui/form/form-rich-text-editor';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryForm } from '../../lib/rhf';

const meta = {
  title: 'Forms/React Hook Form/FormRichTextEditor',
  component: FormRichTextEditor,
  parameters: {
    docs: {
      description: {
        component:
          'TipTap-based rich text editor bound via `control`. The form value is an HTML string. Toolbar covers bold, italic, underline, H2/H3, lists, and links (link URL is asked for via `window.prompt`).',
      },
    },
  },
} satisfies Meta<typeof FormRichTextEditor>;

export default meta;
// Render-only stories: the argless StoryObj keeps `args` optional.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ body: '' }} className="w-[36rem] space-y-6">
      {({ control }) => (
        <FormRichTextEditor
          control={control}
          name="body"
          label="Listing description"
          placeholder="Describe the hardware, connectivity, and SLAs..."
          description="Shown to buyers on the marketplace listing."
        />
      )}
    </StoryForm>
  ),
};

const prefilledHtml = [
  '<h2>H100 SXM cluster</h2>',
  '<p>Eight <strong>NVIDIA H100</strong> GPUs with <em>NVLink</em>, ',
  '<u>3.2 Tbps</u> InfiniBand fabric, and a dedicated 100 Gbps uplink.</p>',
  '<ul><li>2 TB DDR5</li><li>4× 7.68 TB NVMe</li></ul>',
].join('');

export const PrefilledContent: Story = {
  render: () => (
    <StoryForm defaultValues={{ body: prefilledHtml }} className="w-[36rem] space-y-6">
      {(form) => (
        <>
          <FormRichTextEditor control={form.control} name="body" label="Listing description" />
          <p className="text-text-muted max-w-full font-mono text-xs break-all">
            form value (HTML): {form.watch('body')}
          </p>
        </>
      )}
    </StoryForm>
  ),
};

export const Disabled: Story = {
  render: () => (
    <StoryForm
      defaultValues={{
        body: '<p>Editing is locked while the listing is under review.</p>',
      }}
      className="w-[36rem] space-y-6"
    >
      {({ control }) => <FormRichTextEditor control={control} name="body" label="Listing description" disabled />}
    </StoryForm>
  ),
};
