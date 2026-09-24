import { Logo } from '@repo/ui/logo';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import connectionSvg from '~/assets/connection.svg';
import { AnimatedServerRack } from '~/components/animated-server-rack';
import { PRIVACY_URL, TERMS_URL } from '~/lib/branding';

export const Route = createFileRoute('/auth')({
  component: AuthLayout,
});

const connectionsMask = {
  backgroundColor: 'currentColor',
  maskImage: `url(${connectionSvg}), radial-gradient(ellipse 60% 55% at 40% 50%, black 0%, transparent 100%)`,
  WebkitMaskImage: `url(${connectionSvg}), radial-gradient(ellipse 60% 55% at 40% 50%, black 0%, transparent 100%)`,
  maskSize: 'auto 100%, 100% 100%',
  WebkitMaskSize: 'auto 100%, 100% 100%',
  maskRepeat: 'no-repeat',
  WebkitMaskRepeat: 'no-repeat',
  maskPosition: 'left center, center center',
  WebkitMaskPosition: 'left center, center center',
  maskComposite: 'intersect',
  WebkitMaskComposite: 'source-in',
} as const;

const edgeFadeMask = {
  maskImage:
    'linear-gradient(to right, transparent, black 8%, black 92%, transparent), linear-gradient(to bottom, transparent, black 8%, black 92%, transparent)',
  WebkitMaskImage:
    'linear-gradient(to right, transparent, black 8%, black 92%, transparent), linear-gradient(to bottom, transparent, black 8%, black 92%, transparent)',
  maskComposite: 'intersect',
  WebkitMaskComposite: 'source-in',
} as const;

function StatusDot({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="bg-accent h-1.5 w-1.5 rounded-full" />
      <span>{label}</span>
    </div>
  );
}

function AuthLayout() {
  return (
    <div className="bg-bg-secondary flex min-h-svh">
      <div className="relative hidden flex-1 items-center justify-center overflow-hidden lg:flex">
        <div
          className="text-accent pointer-events-none absolute inset-0 my-12 opacity-90 [[data-mode='light']_&]:opacity-50"
          style={connectionsMask}
        />

        <div className="relative z-10 flex flex-col items-center gap-8">
          <Logo className="text-text-muted h-14 w-auto" />

          <p className="text-center font-mono text-2xl leading-relaxed font-medium">
            <span className="text-accent-dim">Global</span>
            <span className="text-accent"> Bare Metal</span>
            <br />
            <span className="text-accent-dim">Management</span>
            <span className="text-accent"> for AI</span>
          </p>

          <div className="relative">
            <div className="bg-bg-secondary absolute -inset-4" style={edgeFadeMask} />
            <AnimatedServerRack />
          </div>

          <div className="text-text-muted flex items-center gap-5 font-mono text-sm font-light">
            <StatusDot label="500+ nodes online" />
            <StatusDot label="2.4 PW Capacity" />
          </div>
        </div>
      </div>

      <div className="flex w-full items-center justify-center p-4 lg:w-auto lg:p-8">
        <div className="border-border bg-bg-primary flex min-h-[calc(100svh-64px)] w-full flex-col items-center justify-center border px-8 py-12 lg:w-[677px] lg:px-16">
          <div className="mb-8 lg:hidden">
            <Logo className="text-accent h-6 w-auto" />
          </div>

          <div className="w-full max-w-[546px] space-y-8">
            <Outlet />

            <div className="text-text-muted text-center font-mono text-[13px] font-light">
              By continuing, you agree to our{' '}
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-accent underline">
                Terms of Service
              </a>{' '}
              and{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="hover:text-accent underline">
                Privacy Policy
              </a>
              .
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
