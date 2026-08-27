import { HoverCard, HoverCardContent, HoverCardTrigger } from '@repo/ui/components/hover-card';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarDays } from 'lucide-react';

const meta = {
  title: 'Overlay/HoverCard',
  component: HoverCard,
  parameters: {
    docs: {
      description: {
        component:
          'Preview card that opens on hover or keyboard focus — for sighted-pointer previews of a link target. Built on the base-ui PreviewCard; the trigger renders an anchor by default.',
      },
    },
  },
  // children is a required prop on HoverCard, but every story supplies its own
  // tree via render — this satisfies the Meta/StoryObj args requirement only.
  args: { children: null },
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProfilePreview: Story = {
  render: () => (
    <p className="font-mono text-sm">
      Provisioned by{' '}
      <HoverCard>
        <HoverCardTrigger href="#" className="text-accent cursor-pointer underline underline-offset-4">
          @hydrahost
        </HoverCardTrigger>
        <HoverCardContent className="w-72">
          <div className="flex gap-4">
            <div className="bg-accent/10 text-accent flex h-10 w-10 shrink-0 items-center justify-center rounded-sm font-mono text-sm font-bold">
              HH
            </div>
            <div className="space-y-1">
              <h4 className="font-mono text-sm font-bold">@hydrahost</h4>
              <p className="text-text-muted text-sm">
                Bare-metal GPU marketplace — created and maintained by Hydra Host.
              </p>
              <div className="text-text-dim flex items-center gap-2 pt-1 text-xs">
                <CalendarDays className="h-3.5 w-3.5" />
                Joined December 2021
              </div>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>{' '}
      on 2026-08-14.
    </p>
  ),
};
