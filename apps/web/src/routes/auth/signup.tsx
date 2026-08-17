import { zodResolver } from '@hookform/resolvers/zod';
import { signUp, useSession } from '@repo/auth/client';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { BRAND_NAME } from '~/lib/branding';
import { sanitizeRedirect } from '~/lib/safe-redirect';

const signupSchema = z.object({
  firstName: z.string().min(1, 'First Name is required'),
  lastName: z.string().min(1, 'Last Name is required'),
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

type SignupFormData = z.infer<typeof signupSchema>;

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/auth/signup')({
  component: SignupPage,
  validateSearch: searchSchema,
});

function SignupPage() {
  const navigate = useNavigate();
  const { refetch: refetchSession } = useSession();
  const { redirect } = useSearch({ from: '/auth/signup' });
  const safeRedirect = sanitizeRedirect(redirect);

  const form = useForm<SignupFormData>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      password: '',
    },
  });

  const signupMutation = useMutation({
    mutationFn: async (data: SignupFormData) => {
      const response = await signUp.email({
        name: `${data.firstName} ${data.lastName}`,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        password: data.password,
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to create account');
      }

      // Generic message to avoid leaking account existence.
      if (!response.data?.token) {
        throw new Error('Failed to create account');
      }

      return response.data;
    },
    meta: { successMessage: 'Account created successfully!' },
  });

  useEffect(() => {
    if (!signupMutation.isSuccess) return;
    void refetchSession();
    navigate({
      to: '/auth/setup-two-factor',
      search: safeRedirect ? { redirect: safeRedirect } : {},
    });
  }, [signupMutation.isSuccess, navigate, safeRedirect, refetchSession]);

  if (signupMutation.isSuccess) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <Loader2 className="text-text-muted h-8 w-8 animate-spin" />
        <p className="text-text-muted font-mono text-sm">Setting up your account...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Create an account" />
        <p className="text-text-muted font-mono text-base font-light">
          Enter your details to get started with {BRAND_NAME}.
        </p>
      </div>

      <form onSubmit={form.handleSubmit((data) => signupMutation.mutate(data))} className="flex flex-col gap-4">
        <FormInput control={form.control} name="firstName" label="First Name" placeholder="John" autoFocus />

        <FormInput control={form.control} name="lastName" label="Last Name" placeholder="Doe" />

        <FormInput control={form.control} name="email" label="Email" type="email" placeholder="m@example.com" />

        <FormInput
          control={form.control}
          name="password"
          label="Password"
          type="password"
          placeholder="Create a password (min 8 characters)"
        />

        {signupMutation.isError && (
          <div className="border-destructive/20 bg-destructive/5 flex items-center gap-3 border p-3">
            <AlertCircle className="text-destructive h-5 w-5" />
            <p className="text-text-primary font-mono text-sm">{signupMutation.error.message}</p>
          </div>
        )}

        <div className="pt-4">
          <FormSubmitButton className="w-full" pending={signupMutation.isPending}>
            Sign Up
          </FormSubmitButton>
        </div>

        <div className="flex items-center justify-center gap-3 pt-2">
          <span className="text-text-muted font-mono text-[13px] font-light">Already have an account?</span>
          <Link
            to="/auth/login"
            search={safeRedirect ? { redirect: safeRedirect } : {}}
            className="text-accent font-mono text-[13px] font-medium underline hover:no-underline"
          >
            Log in
          </Link>
        </div>
      </form>
    </div>
  );
}
