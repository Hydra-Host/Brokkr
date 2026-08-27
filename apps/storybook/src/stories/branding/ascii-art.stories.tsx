import { ASCII_404S, ASCII_LOGOS, ERROR_ASCII, serverRack } from '@repo/ui/ascii-art';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Branding/ASCII Art',
  parameters: {
    docs: {
      description: {
        component:
          'Raw ASCII art constants and helpers from `@repo/ui/ascii-art`: wordmark variants ' +
          '(`ASCII_LOGOS`), 404 art (`ASCII_404S`), the system error panel (`ERROR_ASCII`), ' +
          'and the brandable `serverRack()` generator.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function AsciiBlock({ art }: { art: string }) {
  return <pre className="text-accent font-mono text-xs leading-none">{art}</pre>;
}

export const LogoGallery: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      {ASCII_LOGOS.map((logo, index) => (
        <div key={index}>
          <p className="text-text-muted mb-2 font-mono text-xs">ASCII_LOGOS[{index}]</p>
          <AsciiBlock art={logo} />
        </div>
      ))}
    </div>
  ),
};

export const NotFound: Story = {
  render: () => <AsciiBlock art={ASCII_404S[0]} />,
};

export const SystemError: Story = {
  render: () => <AsciiBlock art={ERROR_ASCII.join('\n')} />,
};

export const ServerRack: Story = {
  render: () => <AsciiBlock art={serverRack('Hydra')} />,
};
