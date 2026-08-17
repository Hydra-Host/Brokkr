import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { twoFactor, useSession } from '@repo/auth/client';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@repo/ui/components/input-otp';
import { Label } from '@repo/ui/components/label';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { sanitizeRedirect } from '~/lib/safe-redirect';

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/auth/two-factor')({
  component: TwoFactorPage,
  validateSearch: searchSchema,
});

function TwoFactorPage() {
  const navigate = useNavigate();
  const { refetch: refetchSession } = useSession();
  const { redirect } = useSearch({ from: '/auth/two-factor' });

  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [backupCode, setBackupCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!verified) return;
    const safeRedirect = sanitizeRedirect(redirect);
    navigate({
      to: '/onboarding/organization',
      search: safeRedirect ? { redirect: safeRedirect } : {},
    });
  }, [verified, navigate, redirect]);

  const handleVerifyTotp = async (code: string) => {
    setVerifying(true);
    setError('');
    try {
      const res = await twoFactor.verifyTotp({ code });
      if (res.error) {
        setError(res.error.message || 'Invalid verification code');
        return;
      }
      await refetchSession();
      setVerified(true);
    } catch {
      setError('Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  const handleVerifyBackup = async () => {
    if (!backupCode.trim()) return;
    setVerifying(true);
    setError('');
    try {
      const res = await twoFactor.verifyBackupCode({ code: backupCode.trim() });
      if (res.error) {
        setError(res.error.message || 'Invalid backup code');
        return;
      }
      await refetchSession();
      setVerified(true);
    } catch {
      setError('Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  if (verified) {
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
        <TypewriterText
          as="h1"
          className="text-accent font-mono text-2xl font-medium"
          text="Two-Factor Authentication"
        />
        <p className="text-text-muted font-mono text-base font-light">
          {mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your backup codes.'}
        </p>
      </div>

      <div className="flex flex-col gap-6">
        {mode === 'totp' ? (
          <div className="flex flex-col gap-4">
            <div className="flex justify-center">
              <InputOTP maxLength={6} onComplete={handleVerifyTotp} disabled={verifying} autoFocus>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <span className="text-text-muted">-</span>
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            {verifying && (
              <div className="flex justify-center">
                <Loader2 className="text-text-muted h-4 w-4 animate-spin" />
              </div>
            )}
            {error && <p className="text-destructive text-center font-mono text-sm">{error}</p>}
            <div className="text-center">
              <button
                type="button"
                className="text-text-muted hover:text-accent font-mono text-[13px] underline"
                onClick={() => {
                  setMode('backup');
                  setError('');
                }}
              >
                Use a backup code instead
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="backup-code">Backup code</Label>
              <Input
                id="backup-code"
                placeholder="Enter your backup code"
                value={backupCode}
                onChange={(e) => setBackupCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleVerifyBackup();
                }}
                autoFocus
              />
            </div>
            {error && <p className="text-destructive font-mono text-sm">{error}</p>}
            <Button className="w-full" onClick={handleVerifyBackup} disabled={verifying || !backupCode.trim()}>
              {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Verify
            </Button>
            <div className="text-center">
              <button
                type="button"
                className="text-text-muted hover:text-accent font-mono text-[13px] underline"
                onClick={() => {
                  setMode('totp');
                  setError('');
                }}
              >
                Use authenticator app instead
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-center pt-2">
          <Link to="/auth/login" className="text-accent font-mono text-[13px] font-medium underline hover:no-underline">
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}
