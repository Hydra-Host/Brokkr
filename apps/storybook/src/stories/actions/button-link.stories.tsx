import { ButtonLink } from '@repo/ui/components/button-link';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowRight } from 'lucide-react';
import { withRouter } from '../../lib/decorators';

const meta = {
  title: 'Actions/ButtonLink',
  component: ButtonLink,
  decorators: [withRouter],
  parameters: {
    docs: {
      description: {
        component:
          'A `Button` that renders a TanStack Router `<Link>`. Requires router context — these stories run inside an in-memory router.',
      },
    },
  },
} satisfies Meta<typeof ButtonLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ButtonLink to="/">Go to dashboard</ButtonLink>,
};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <ButtonLink to="/">Primary</ButtonLink>
      <ButtonLink to="/" variant="outline">
        Outline
      </ButtonLink>
      <ButtonLink to="/" variant="ghost">
        Ghost
      </ButtonLink>
      <ButtonLink to="/" variant="link">
        Link <ArrowRight />
      </ButtonLink>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <ButtonLink to="/" disabled>
      Disabled link
    </ButtonLink>
  ),
};
