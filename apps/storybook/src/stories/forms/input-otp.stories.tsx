import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@repo/ui/components/input-otp';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

const DIGITS_ONLY = '^\\d+$';

const otpSlots = (
  <>
    <InputOTPGroup>
      <InputOTPSlot index={0} />
      <InputOTPSlot index={1} />
      <InputOTPSlot index={2} />
    </InputOTPGroup>
    <InputOTPSeparator />
    <InputOTPGroup>
      <InputOTPSlot index={3} />
      <InputOTPSlot index={4} />
      <InputOTPSlot index={5} />
    </InputOTPGroup>
  </>
);

const meta = {
  title: 'Forms/Primitives/InputOTP',
  component: InputOTP,
  argTypes: {
    maxLength: { control: false },
    render: { control: false },
  },
  args: {
    maxLength: 6,
    pattern: DIGITS_ONLY,
    children: otpSlots,
  },
} satisfies Meta<typeof InputOTP>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: '493' },
};

const VerificationDemo = () => {
  const [value, setValue] = useState('');
  const complete = value.length === 6;

  return (
    <div className="flex flex-col items-center gap-3">
      <InputOTP
        maxLength={6}
        pattern={DIGITS_ONLY}
        value={value}
        onChange={setValue}
        onComplete={(code: string) => console.log('verify', code)}
      >
        {otpSlots}
      </InputOTP>
      <p className="text-text-muted font-mono text-xs">
        {complete ? (
          <span className="text-status-online">Code complete — verifying…</span>
        ) : (
          `${value.length}/6 digits entered`
        )}
      </p>
    </div>
  );
};

export const Controlled: Story = {
  render: () => <VerificationDemo />,
};
