import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Copy, Download, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import QRCode from 'react-qr-code';
import { z } from 'zod';

import { revokeOtherSessions, twoFactor, useSession } from '@repo/auth/client';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@repo/ui/components/input-otp';
import { Label } from '@repo/ui/components/label';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';
import { BRAND_NAME } from '~/lib/branding';
import { sanitizeRedirect } from '~/lib/safe-redirect';

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/auth/setup-two-factor')({
  component: SetupTwoFactorPage,
  validateSearch: searchSchema,
});

function SetupTwoFactorPage() {
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: '/auth/setup-two-factor' });
  const { refetch: refetchSession } = useSession();

  const [step, setStep] = useState<'enable' | 'backup'>('enable');
  const [password, setPassword] = useState('');
  const [totpURI, setTotpURI] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [showSecret, setShowSecret] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const { copy, copied } = useCopyToClipboard();

  const secret = totpURI ? new URL(totpURI).searchParams.get('secret') || '' : '';

  const handleEnable = async () => {
    if (!password) return;
    setEnabling(true);
    setError('');
    try {
      const res = await twoFactor.enable({ password });
      if (res.error) {
        setError(res.error.message || 'Failed to enable two-factor authentication');
        return;
      }
      setTotpURI(res.data.totpURI);
      setBackupCodes(res.data.backupCodes);
    } catch {
      setError('Failed to enable two-factor authentication');
    } finally {
      setEnabling(false);
    }
  };

  const handleVerify = async (code: string) => {
    setVerifying(true);
    setError('');
    try {
      const res = await twoFactor.verifyTotp({ code });
      if (res.error) {
        setError(res.error.message || 'Invalid verification code');
        return;
      }
      // Revoke pre-enrollment sessions so a stale twoFactorEnabled=false session can't bounce the user back here.
      try {
        await revokeOtherSessions();
      } catch (error) {
        console.warn('Failed to revoke other sessions', error);
      }
      await refetchSession();
      setStep('backup');
    } catch {
      setError('Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  const handleCopyAll = async () => {
    await copy(backupCodes.join('\n'));
  };

  const handleDownload = () => {
    const content = `${BRAND_NAME} Backup Codes\n${'='.repeat(30)}\n\nSave these codes in a safe place.\nEach code can only be used once.\n\n${backupCodes.join('\n')}\n`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${BRAND_NAME.toLowerCase()}-backup-codes.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (step === 'backup') {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col items-center gap-4">
          <div className="bg-status-online/10 flex h-12 w-12 items-center justify-center">
            <ShieldCheck className="text-status-online h-6 w-6" />
          </div>
          <TypewriterText
            as="h1"
            className="text-accent font-mono text-2xl font-medium"
            text="Save Your Backup Codes"
          />
          <p className="text-text-muted text-center font-mono text-base font-light">
            Save these codes in a safe place. Each code can only be used once to sign in if you lose access to your
            authenticator app.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {backupCodes.map((code) => (
              <div key={code} className="border-border bg-bg-secondary border px-3 py-2 text-center font-mono text-sm">
                {code}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={handleCopyAll}>
              {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              {copied ? 'Copied' : 'Copy All'}
            </Button>
            <Button variant="outline" className="flex-1" onClick={handleDownload}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          </div>

          <div className="pt-4">
            <Button
              className="w-full"
              onClick={() => {
                const safeRedirect = sanitizeRedirect(redirect);
                navigate({ to: '/onboarding/organization', search: safeRedirect ? { redirect: safeRedirect } : {} });
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <TypewriterText
          as="h1"
          className="text-accent font-mono text-2xl font-medium"
          text="Set Up Two-Factor Authentication"
        />
        <p className="text-text-muted font-mono text-base font-light">
          Two-factor authentication is required to use {BRAND_NAME}. Set up your authenticator app to continue.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        {!totpURI ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password">Confirm your password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleEnable();
                }}
              />
            </div>
            {error && <p className="text-destructive font-mono text-sm">{error}</p>}
            <div className="pt-4">
              <Button className="w-full" onClick={handleEnable} disabled={enabling || !password}>
                {enabling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <p className="text-text-muted font-mono text-sm">
                Scan this QR code with your authenticator app (e.g. Google Authenticator, Authy, 1Password).
              </p>
              <div className="flex justify-center bg-white p-4">
                <QRCode value={totpURI} size={200} />
              </div>
              <div className="text-center">
                <button
                  type="button"
                  className="text-text-muted hover:text-accent font-mono text-[13px] underline"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? 'Hide manual entry key' : "Can't scan? Enter key manually"}
                </button>
                {showSecret && (
                  <div className="border-border bg-bg-secondary mt-2 border px-3 py-2 font-mono text-xs break-all">
                    {secret}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Enter the 6-digit code from your app</Label>
              <div className="flex justify-center">
                <InputOTP maxLength={6} onComplete={handleVerify} disabled={verifying}>
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
