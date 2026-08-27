import { CloudInitEditor } from '@repo/ui/provision/cloud-init-editor';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { StoryForm } from '../../lib/rhf';

const VALID_YAML = `#cloud-config
users:
  - name: ada
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA ada@hydrahost

packages:
  - htop
  - nvtop

runcmd:
  - echo "provisioned by cloud-init"
`;

// Unbalanced bracket makes js-yaml throw as soon as the value re-validates.
const BROKEN_YAML = `#cloud-config
packages: [htop, nvtop
runcmd:
  - echo "missing closing bracket above"
`;

const meta = {
  title: 'Domain/CloudInitEditor',
  component: CloudInitEditor,
  parameters: {
    docs: {
      description: {
        component:
          'YAML textarea bound to a react-hook-form field (`cloudInit` by default). Content is parsed with js-yaml on every change; the first line of any parse error surfaces in a destructive alert below the editor.',
      },
    },
  },
} satisfies Meta<typeof CloudInitEditor>;

export default meta;
// Render-only stories: the component takes a live `control` from useForm, which
// cannot be provided as static args, so Story is left untyped.
type Story = StoryObj;

export const Default: Story = {
  render: () => (
    <StoryForm defaultValues={{ cloudInit: VALID_YAML }} className="w-[40rem] space-y-6">
      {({ control }) => <CloudInitEditor control={control} />}
    </StoryForm>
  ),
};

export const InvalidYaml: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Prefilled with broken YAML; the play function types a newline so the on-change validator runs and the js-yaml error alert appears.',
      },
    },
  },
  render: () => (
    <StoryForm defaultValues={{ cloudInit: BROKEN_YAML }} className="w-[40rem] space-y-6">
      {({ control }) => <CloudInitEditor control={control} />}
    </StoryForm>
  ),
  play: async ({ canvasElement }) => {
    const textarea = within(canvasElement).getByRole('textbox');
    await userEvent.type(textarea, '\n');
  },
};

export const Disabled: Story = {
  render: () => (
    <StoryForm defaultValues={{ cloudInit: VALID_YAML }} className="w-[40rem] space-y-6">
      {({ control }) => <CloudInitEditor control={control} disabled />}
    </StoryForm>
  ),
};
