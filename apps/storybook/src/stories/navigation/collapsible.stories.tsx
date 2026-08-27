import { Button } from '@repo/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@repo/ui/components/collapsible';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

const meta = {
  title: 'Navigation/Collapsible',
  component: Collapsible,
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledCollapsible() {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-[360px]">
      <div className="flex items-center justify-between">
        <span className="text-text-primary font-mono text-sm font-medium">
          Provisioning log ({open ? 'open' : 'closed'})
        </span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            Toggle
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="border-border text-text-muted mt-2 border p-3 font-mono text-xs">
          <p>[00:01] allocating node…</p>
          <p>[00:04] imaging OS…</p>
          <p>[00:19] configuring network…</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export const Controlled: Story = {
  render: () => <ControlledCollapsible />,
};

export const ChevronTriggerRow: Story = {
  render: () => (
    <Collapsible className="w-[360px]">
      <CollapsibleTrigger className="group border-border hover:text-accent text-text-primary flex w-full items-center justify-between border px-3 py-2 font-mono text-sm transition-colors">
        <span>Advanced options</span>
        <ChevronDown className="text-text-muted h-4 w-4 transition-transform duration-200 group-data-[panel-open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border text-text-muted border border-t-0 p-3 font-mono text-xs">
          <p>RAID layout, kernel params, and PXE overrides live here.</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  ),
};
