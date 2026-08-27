import { Transition } from '@headlessui/react';
import { useSession } from '@repo/auth/client';
import { Button } from '@repo/ui/components/button';
import { Logo } from '@repo/ui/logo';
import { cn } from '@repo/ui/utils';
import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { COMPANY_URL } from '~/lib/branding';
import { getDocsUrl } from '~/lib/runtime-config';
import { PluginSlot } from '~/plugin-host';

type HostNavItem =
  | { label: string; to: string; external: true }
  | { label: string; to: '/inventory'; external?: false };

const leadingNavItems: HostNavItem[] = [
  { label: 'Docs', to: getDocsUrl(), external: true },
  { label: 'Inventory', to: '/inventory' },
];

const trailingNavItems: HostNavItem[] = [{ label: 'Learn More', to: COMPANY_URL, external: true }];

export const Route = createFileRoute('/_navbar-layout')({
  component: NavbarLayout,
});

function NavbarLayout() {
  const { data: session } = useSession();
  const user = session?.user ?? null;
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 10);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <nav
        className={cn(
          'border-purple/20 fixed inset-x-0 top-0 z-50 flex items-center justify-between border-b px-4 py-4 transition-all duration-300 md:px-6',
          scrolled
            ? 'bg-background/95 shadow-lg backdrop-blur-lg'
            : 'from-background/80 bg-linear-to-b to-transparent backdrop-blur-xs',
        )}
      >
        <div className="flex items-center gap-4 md:gap-6">
          <Link to="/inventory" className="group transition-transform hover:scale-105">
            <Logo className="-mt-2 h-8 w-auto" />
          </Link>

          <div className="hidden items-center gap-4 md:flex">
            {leadingNavItems.map((item) => (
              <HostNavLink key={item.to} item={item} variant="desktop" pathname={location.pathname} />
            ))}
            <PluginSlot name="public-navbar" variant="desktop" />
            {trailingNavItems.map((item) => (
              <HostNavLink key={item.to} item={item} variant="desktop" pathname={location.pathname} />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {user ? (
            <Link to="/" className="bg-primary hidden rounded-md px-3 py-2 text-sm font-semibold text-black md:block">
              Go to Dashboard
            </Link>
          ) : (
            <div className="hidden items-center gap-3 md:flex">
              <Link
                to="/auth/login"
                className={cn('hover:bg-purple-darker rounded-md px-3 py-2 text-sm font-semibold')}
                preload="intent"
              >
                Log In
              </Link>

              <Link
                to="/auth/signup"
                className={cn('bg-primary rounded-md px-3 py-2 text-sm font-semibold text-black')}
                preload="intent"
              >
                Sign Up
              </Link>
            </div>
          )}

          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle navigation menu</span>
          </Button>
        </div>
      </nav>

      <Transition.Root show={mobileMenuOpen} as={Fragment}>
        <div className="fixed inset-0 z-50 md:hidden">
          <Transition.Child
            as={Fragment}
            enter="ease-in-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in-out duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="bg-background/80 fixed inset-0 backdrop-blur-xs" onClick={() => setMobileMenuOpen(false)} />
          </Transition.Child>

          <Transition.Child
            as={Fragment}
            enter="transform transition ease-in-out duration-300"
            enterFrom="translate-x-full"
            enterTo="translate-x-0"
            leave="transform transition ease-in-out duration-300"
            leaveFrom="translate-x-0"
            leaveTo="translate-x-full"
          >
            <div className="bg-background border-border fixed top-0 right-0 h-full w-full max-w-xs border-l shadow-xl">
              <div className="border-border flex items-center justify-between border-b p-4">
                <Logo className="h-8 w-auto" />
                <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(false)}>
                  <X className="h-5 w-5" />
                  <span className="sr-only">Close menu</span>
                </Button>
              </div>

              <nav className="space-y-2 p-4">
                {leadingNavItems.map((item) => (
                  <HostNavLink
                    key={item.to}
                    item={item}
                    variant="mobile"
                    pathname={location.pathname}
                    onNavigate={() => setMobileMenuOpen(false)}
                  />
                ))}
                <PluginSlot name="public-navbar" variant="mobile" onNavigate={() => setMobileMenuOpen(false)} />
                {trailingNavItems.map((item) => (
                  <HostNavLink
                    key={item.to}
                    item={item}
                    variant="mobile"
                    pathname={location.pathname}
                    onNavigate={() => setMobileMenuOpen(false)}
                  />
                ))}

                <div className="border-border space-y-2 border-t pt-6">
                  {user ? (
                    <Link to="/" onClick={() => setMobileMenuOpen(false)} className="block">
                      <Button variant="ghost" className="w-full">
                        Go to Dashboard
                      </Button>
                    </Link>
                  ) : (
                    <>
                      <Link to="/auth/login" onClick={() => setMobileMenuOpen(false)} className="block">
                        <Button variant="outline" className="w-full">
                          Log In
                        </Button>
                      </Link>
                      <Link to="/auth/signup" onClick={() => setMobileMenuOpen(false)} className="block">
                        <Button className="w-full">Sign Up</Button>
                      </Link>
                    </>
                  )}
                </div>
              </nav>
            </div>
          </Transition.Child>
        </div>
      </Transition.Root>

      <div className="px-4 pt-24 pb-12 md:px-6">
        <Outlet />
      </div>
    </>
  );
}

function HostNavLink({
  item,
  variant,
  pathname,
  onNavigate,
}: {
  item: HostNavItem;
  variant: 'desktop' | 'mobile';
  pathname: string;
  onNavigate?: () => void;
}) {
  if (item.external) {
    return (
      <a
        href={item.to}
        onClick={onNavigate}
        className={
          variant === 'desktop'
            ? 'rounded-md bg-transparent px-3 py-2 text-sm font-semibold'
            : cn(
                'block rounded-md px-3 py-2 text-base font-semibold transition-colors',
                'text-muted-foreground hover:bg-muted hover:text-white',
              )
        }
        target="_blank"
        rel="noopener noreferrer"
      >
        {item.label}
      </a>
    );
  }

  const isCurrent = pathname === item.to || pathname.startsWith(`${item.to}/`);

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={
        variant === 'desktop'
          ? cn(
              isCurrent ? 'bg-primary/10 text-primary' : 'bg-transparent',
              'rounded-md px-3 py-2 text-sm font-semibold',
            )
          : cn(
              'block rounded-md px-3 py-2 text-base font-semibold transition-colors',
              isCurrent ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-white',
            )
      }
      preload="intent"
    >
      {item.label}
    </Link>
  );
}
