import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@repo/ui/components/accordion';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Avatar, AvatarFallback } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Calendar } from '@repo/ui/components/calendar';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Checkbox } from '@repo/ui/components/checkbox';
import { Combobox } from '@repo/ui/components/combobox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { Progress } from '@repo/ui/components/progress';
import { RadioGroup, RadioGroupItem } from '@repo/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { Separator } from '@repo/ui/components/separator';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Slider } from '@repo/ui/components/slider';
import { Switch } from '@repo/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/components/tabs';
import { Textarea } from '@repo/ui/components/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Info, Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { comboboxOptions, selectOptions } from '../lib/fixtures';

const SECTIONS = [
  'Button',
  'Badge',
  'Input',
  'Textarea',
  'Checkbox',
  'Select',
  'Combobox',
  'Switch',
  'Slider',
  'Radio Group',
  'Calendar',
  'Progress',
  'Avatar',
  'Alert',
  'Card',
  'Tabs',
  'Accordion',
  'Dialog',
  'Tooltip',
  'Separator',
  'Skeleton',
  'Table',
] as const;

const anchor = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

function Section({ name, children }: { name: (typeof SECTIONS)[number]; children: ReactNode }) {
  return (
    <section id={anchor(name)} className="scroll-mt-20">
      <h2 className="text-accent mb-4 font-mono text-lg font-bold tracking-wide uppercase">{name}</h2>
      <div className="border-border bg-bg-secondary rounded-sm border p-6">{children}</div>
    </section>
  );
}

function ComponentsAtAGlance() {
  const [sliderValue, setSliderValue] = useState(33);
  const [framework, setFramework] = useState('');
  const [date, setDate] = useState<Date | undefined>(undefined);

  return (
    <div className="bg-bg-primary text-text-primary min-h-screen">
      <div className="border-border bg-bg-secondary border-b px-6 py-8">
        <div className="mx-auto max-w-7xl">
          <h1 className="text-accent font-mono text-2xl font-bold tracking-wide uppercase">Component Library</h1>
          <p className="text-text-muted mt-2 font-mono text-sm">
            All base UI primitives in one place. Every component has its own stories with controls in the sidebar.
          </p>
        </div>
      </div>
      <div className="mx-auto flex max-w-7xl gap-8 px-6 py-8">
        <nav className="sticky top-8 hidden max-h-[calc(100vh-4rem)] w-56 shrink-0 self-start overflow-y-auto lg:block">
          <h3 className="text-accent mb-2 font-mono text-xs font-bold tracking-widest uppercase">Components</h3>
          <ul className="space-y-1">
            {SECTIONS.map((name) => (
              <li key={name}>
                {/* Not an <a href="#..">: hash navigation escapes Storybook's manager into the raw iframe URL. */}
                <button
                  type="button"
                  onClick={() => document.getElementById(anchor(name))?.scrollIntoView({ behavior: 'smooth' })}
                  className="text-text-muted hover:text-accent block cursor-pointer py-0.5 font-mono text-xs transition-colors"
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 space-y-10">
          <Section name="Button">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <Button>Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="success">Success</Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button>Default</Button>
                <Button size="lg">Large</Button>
                <Button disabled>Disabled</Button>
              </div>
            </div>
          </Section>

          <Section name="Badge">
            <div className="flex flex-wrap gap-3">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="online">Online</Badge>
              <Badge variant="offline">Offline</Badge>
              <Badge variant="price">Price</Badge>
            </div>
          </Section>

          <Section name="Input">
            <div className="max-w-sm space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ov-input">Label</Label>
                <Input id="ov-input" placeholder="Type something..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ov-input-disabled">Disabled</Label>
                <Input id="ov-input-disabled" placeholder="Disabled input" disabled />
              </div>
            </div>
          </Section>

          <Section name="Textarea">
            <div className="max-w-sm">
              <Textarea placeholder="Write your message here..." />
            </div>
          </Section>

          <Section name="Checkbox">
            <div className="space-y-3">
              <Checkbox label="Accept terms and conditions" />
              <Checkbox label="Checked by default" defaultChecked />
              <Checkbox label="Disabled" disabled />
            </div>
          </Section>

          <Section name="Select">
            <div className="max-w-sm">
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select an operating system" />
                </SelectTrigger>
                <SelectContent>
                  {selectOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Section>

          <Section name="Combobox">
            <div className="max-w-sm">
              <Combobox
                options={comboboxOptions}
                value={framework}
                setValue={setFramework}
                placeholder="Search regions..."
              />
            </div>
          </Section>

          <Section name="Switch">
            <div className="space-y-4">
              <div className="flex items-center space-x-3">
                <Switch id="ov-switch" />
                <Label htmlFor="ov-switch">Enable notifications</Label>
              </div>
              <div className="flex items-center space-x-3">
                <Switch id="ov-switch-disabled" disabled />
                <Label htmlFor="ov-switch-disabled">Disabled</Label>
              </div>
            </div>
          </Section>

          <Section name="Slider">
            <div className="max-w-sm space-y-3">
              <Slider
                min={0}
                max={100}
                step={1}
                value={sliderValue}
                onValueChange={(value) => setSliderValue(Array.isArray(value) ? (value[0] ?? 0) : value)}
              />
              <p className="text-text-muted font-mono text-sm">Value: {sliderValue}</p>
            </div>
          </Section>

          <Section name="Radio Group">
            <RadioGroup defaultValue="option-1" className="grid gap-2">
              {['option-1', 'option-2', 'option-3'].map((value, index) => (
                <div key={value} className="flex items-center space-x-2">
                  <RadioGroupItem value={value} id={`ov-${value}`} />
                  <Label htmlFor={`ov-${value}`}>Option {index + 1}</Label>
                </div>
              ))}
            </RadioGroup>
          </Section>

          <Section name="Calendar">
            <Calendar
              mode="single"
              selected={date}
              onSelect={setDate}
              className="border-border inline-block rounded-sm border"
            />
          </Section>

          <Section name="Progress">
            <div className="max-w-sm space-y-4">
              {[25, 50, 75].map((value) => (
                <div key={value} className="space-y-1">
                  <p className="text-text-muted font-mono text-xs">{value}%</p>
                  <Progress value={value} />
                </div>
              ))}
            </div>
          </Section>

          <Section name="Avatar">
            <div className="flex gap-4">
              {['CN', 'JD', 'AB'].map((initials) => (
                <Avatar key={initials}>
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              ))}
            </div>
          </Section>

          <Section name="Alert">
            <div className="space-y-4">
              <Alert>
                <Terminal className="h-4 w-4" />
                <AlertTitle>Default Alert</AlertTitle>
                <AlertDescription>This is an informational alert message.</AlertDescription>
              </Alert>
              <Alert variant="success">
                <Info className="h-4 w-4" />
                <AlertTitle>Success</AlertTitle>
                <AlertDescription>Operation completed successfully.</AlertDescription>
              </Alert>
              <Alert variant="warning">
                <Info className="h-4 w-4" />
                <AlertTitle>Warning</AlertTitle>
                <AlertDescription>Please review before proceeding.</AlertDescription>
              </Alert>
              <Alert variant="destructive">
                <Info className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>Something went wrong. Please try again.</AlertDescription>
              </Alert>
            </div>
          </Section>

          <Section name="Card">
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>Card Title</CardTitle>
                <CardDescription>Card description with additional context.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-text-primary text-sm">Card content goes here. This can contain any elements.</p>
              </CardContent>
              <CardFooter className="gap-3">
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
                <Button size="sm">Save</Button>
              </CardFooter>
            </Card>
          </Section>

          <Section name="Tabs">
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                <p className="text-text-muted text-sm">This is the overview tab content.</p>
              </TabsContent>
              <TabsContent value="settings">
                <p className="text-text-muted text-sm">Settings live here.</p>
              </TabsContent>
              <TabsContent value="logs">
                <p className="text-text-muted text-sm">Logs stream here.</p>
              </TabsContent>
            </Tabs>
          </Section>

          <Section name="Accordion">
            <Accordion type="single" collapsible>
              <AccordionItem value="what">
                <AccordionTrigger>What is this?</AccordionTrigger>
                <AccordionContent>A quick visual index of every base primitive in @repo/ui.</AccordionContent>
              </AccordionItem>
              <AccordionItem value="how">
                <AccordionTrigger>How do I use it?</AccordionTrigger>
                <AccordionContent>
                  Import from @repo/ui/components/* — each section here has a full story with controls in the sidebar.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="a11y">
                <AccordionTrigger>Is it accessible?</AccordionTrigger>
                <AccordionContent>
                  Components are built on Base UI primitives with keyboard and ARIA support.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Section>

          <Section name="Dialog">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open Dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Example dialog</DialogTitle>
                  <DialogDescription>Dialogs trap focus and close on escape or backdrop click.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline">Close</Button>} />
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Section>

          <Section name="Tooltip">
            <div className="flex gap-4">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>Tooltip content</TooltipContent>
              </Tooltip>
            </div>
          </Section>

          <Section name="Separator">
            <div className="space-y-4">
              <div>
                <p className="text-text-muted mb-2 text-sm">Horizontal</p>
                <Separator />
              </div>
              <div className="flex h-8 items-center gap-4">
                <p className="text-text-muted text-sm">Item A</p>
                <Separator orientation="vertical" />
                <p className="text-text-muted text-sm">Item B</p>
                <Separator orientation="vertical" />
                <p className="text-text-muted text-sm">Item C</p>
              </div>
            </div>
          </Section>

          <Section name="Skeleton">
            <div className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          </Section>

          <Section name="Table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Alice Johnson</TableCell>
                  <TableCell>
                    <Badge variant="success">Active</Badge>
                  </TableCell>
                  <TableCell>Admin</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Bob Smith</TableCell>
                  <TableCell>
                    <Badge variant="offline">Inactive</Badge>
                  </TableCell>
                  <TableCell>User</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Carol Williams</TableCell>
                  <TableCell>
                    <Badge variant="warning">Pending</Badge>
                  </TableCell>
                  <TableCell>Editor</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Section>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Overview',
  component: ComponentsAtAGlance,
  parameters: { layout: 'fullscreen', docs: { disable: true } },
  tags: ['!autodocs'],
} satisfies Meta<typeof ComponentsAtAGlance>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllComponents: Story = {};
