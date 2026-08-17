import { zodResolver } from '@hookform/resolvers/zod';
import { signIn, useSession } from '@repo/auth/client';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute, Link, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { isLocalSimulationEnabled } from '~/lib/env';
import { sanitizeRedirect } from '~/lib/safe-redirect';

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormData = z.infer<typeof loginSchema>;

const SIM_DEFAULTS: LoginFormData = { email: 'brokkr@brokkr.local', password: 'brokkr' };
const EMPTY_DEFAULTS: LoginFormData = { email: '', password: '' };

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/auth/login')({
  component: LoginPage,
  validateSearch: searchSchema,
});

function LoginPage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { redirect } = useSearch({ from: '/auth/login' });
  const safeRedirect = sanitizeRedirect(redirect);
  const redirectTo = safeRedirect ?? '/';

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: isLocalSimulationEnabled() ? SIM_DEFAULTS : EMPTY_DEFAULTS,
  });

  const loginMutation = useMutation({
    mutationFn: async (data: LoginFormData) => {
      const response = await signIn.email({
        email: data.email,
        password: data.password,
      });

      if (response.error) {
        throw new Error(response.error.message || 'Invalid email or password');
      }

      return response.data;
    },
  });

  useEffect(() => {
    if (loginMutation.isSuccess && session) {
      navigate({ to: redirectTo });
    }
  }, [loginMutation.isSuccess, session, navigate, redirectTo]);

  if (!loginMutation.isSuccess && session) {
    return <Navigate to={redirectTo} />;
  }

  if (loginMutation.isSuccess) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <Loader2 className="text-text-muted h-8 w-8 animate-spin" />
        <p className="text-text-muted font-mono text-sm">Signing you in...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <TypewriterText as="h1" className="text-accent font-mono text-2xl font-medium" text="Login" />
        <p className="text-text-muted font-mono text-base font-light">Welcome back! Provide your user login details.</p>
      </div>

      <form onSubmit={form.handleSubmit((data) => loginMutation.mutate(data))} className="flex flex-col gap-4">
        <FormInput
          control={form.control}
          name="email"
          label="Email Address"
          type="email"
          placeholder="Enter your email here"
          autoFocus
        />

        <FormInput
          control={form.control}
          name="password"
          label="Password"
          type="password"
          placeholder="Enter your password"
        />

        {loginMutation.isError && (
          <div className="border-destructive/20 bg-destructive/5 flex items-center gap-3 border p-3">
            <AlertCircle className="text-destructive h-5 w-5" />
            <p className="text-text-primary font-mono text-sm">{loginMutation.error.message}</p>
          </div>
        )}

        <div className="pt-4">
          <FormSubmitButton className="w-full" pending={loginMutation.isPending}>
            Login
          </FormSubmitButton>
        </div>

        <div className="flex items-start justify-between pt-2">
          <Link
            to="/auth/forgot-password"
            className="text-text-muted hover:text-accent font-mono text-[13px] font-light underline"
          >
            Forgot password?
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-text-muted font-mono text-[13px] font-light">Don&apos;t have an account?</span>
            <Link
              to="/auth/signup"
              search={safeRedirect ? { redirect: safeRedirect } : {}}
              className="text-accent font-mono text-[13px] font-medium underline hover:no-underline"
            >
              Sign up
            </Link>
          </div>
        </div>
      </form>
    </div>
  );
}
