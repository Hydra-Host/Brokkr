import { zodResolver } from '@hookform/resolvers/zod';
import { resetPassword } from '@repo/auth/client';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const resetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

const resetPasswordSearchSchema = z.object({
  token: z.string().optional(),
});

export const Route = createFileRoute('/auth/reset-password')({
  validateSearch: resetPasswordSearchSchema,
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token } = Route.useSearch();

  const form = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: {
      password: '',
      confirmPassword: '',
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (data: ResetPasswordFormData) => {
      if (!token) {
        throw new Error('Reset token is missing. Please request a new reset link.');
      }

      const response = await resetPassword({
        newPassword: data.password,
        token,
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to reset password');
      }

      return response.data;
    },
  });

  if (!token) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Invalid Link" />
          <div className="border-destructive/20 bg-destructive/5 flex items-start gap-3 border p-4">
            <AlertCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
            <p className="text-text-primary font-mono text-sm">
              This password reset link is invalid or has expired. Please request a new one.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link
            to="/auth/forgot-password"
            className="text-accent font-mono text-[13px] font-medium underline hover:no-underline"
          >
            Request new reset link
          </Link>
        </div>
      </div>
    );
  }

  if (resetPasswordMutation.isSuccess) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Password Reset" />
          <div className="border-accent/20 bg-accent/5 flex items-start gap-3 border p-4">
            <CheckCircle className="text-accent mt-0.5 h-5 w-5 shrink-0" />
            <p className="text-text-primary font-mono text-sm">
              Your password has been reset successfully. You can now log in with your new password.
            </p>
          </div>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => navigate({ to: '/auth/login' })}
            className="text-accent font-mono text-[13px] font-medium underline hover:no-underline"
          >
            Go to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Reset Password" />
        <p className="text-text-muted font-mono text-base font-light">Enter your new password below.</p>
      </div>

      <form onSubmit={form.handleSubmit((data) => resetPasswordMutation.mutate(data))} className="flex flex-col gap-4">
        <FormInput
          control={form.control}
          name="password"
          label="New Password"
          type="password"
          placeholder="Enter your new password (min 8 characters)"
          autoFocus
        />

        <FormInput
          control={form.control}
          name="confirmPassword"
          label="Confirm Password"
          type="password"
          placeholder="Confirm your new password"
        />

        {resetPasswordMutation.isError && (
          <div className="border-destructive/20 bg-destructive/5 flex items-center gap-3 border p-3">
            <AlertCircle className="text-destructive h-5 w-5" />
            <p className="text-text-primary font-mono text-sm">{resetPasswordMutation.error.message}</p>
          </div>
        )}

        <div className="pt-4">
          <FormSubmitButton className="w-full" pending={resetPasswordMutation.isPending}>
            Reset Password
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
