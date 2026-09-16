import { zodResolver } from '@hookform/resolvers/zod';
import { requestPasswordReset } from '@repo/auth/client';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
});

type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

export const Route = createFileRoute('/auth/forgot-password')({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const form = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: {
      email: '',
    },
  });

  const forgotPasswordMutation = useMutation({
    mutationFn: async (data: ForgotPasswordFormData) => {
      const response = await requestPasswordReset({
        email: data.email,
        // Absolute on purpose: better-auth resolves a relative callback against the API origin, which serves no SPA route.
        redirectTo: new URL('/auth/reset-password', window.location.origin).href,
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to send reset link');
      }

      return response.data;
    },
  });

  if (forgotPasswordMutation.isSuccess) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Check Your Email" />
          <div className="border-accent/20 bg-accent/5 flex items-start gap-3 border p-4">
            <CheckCircle className="text-accent mt-0.5 h-5 w-5 shrink-0" />
            <p className="text-text-primary font-mono text-sm">
              If an account exists with that email, we've sent password reset instructions. Check your inbox and spam
              folder.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3 pt-2">
          <Link to="/auth/login" className="text-accent font-mono text-[13px] font-medium underline hover:no-underline">
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Forgot Password" />
        <p className="text-text-muted font-mono text-base font-light">
          Enter your email and we'll send you a reset link.
        </p>
      </div>

      <form onSubmit={form.handleSubmit((data) => forgotPasswordMutation.mutate(data))} className="flex flex-col gap-4">
        <FormInput
          control={form.control}
          name="email"
          label="Email Address"
          type="email"
          placeholder="Enter your email here"
          autoFocus
        />

        {forgotPasswordMutation.isError && (
          <div className="border-destructive/20 bg-destructive/5 flex items-center gap-3 border p-3">
            <AlertCircle className="text-destructive h-5 w-5" />
            <p className="text-text-primary font-mono text-sm">{forgotPasswordMutation.error.message}</p>
          </div>
        )}

        <div className="pt-4">
          <FormSubmitButton className="w-full" pending={forgotPasswordMutation.isPending}>
            Send Reset Link
          </FormSubmitButton>
        </div>

        <div className="flex items-center justify-center gap-3 pt-2">
          <span className="text-text-muted font-mono text-[13px] font-light">Remember your password?</span>
          <Link to="/auth/login" className="text-accent font-mono text-[13px] font-medium underline hover:no-underline">
            Back to login
          </Link>
        </div>
      </form>
    </div>
  );
}
