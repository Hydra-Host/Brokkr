import { Transition } from '@headlessui/react';
import { useSession } from '@repo/auth/client';
import { Button } from '@repo/ui/components/button';
import { Logo } from '@repo/ui/logo';
import { cn } from '@repo/ui/utils';
import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { COMPANY_URL } from '~/lib/branding';

const navItems = [
  {
    label: 'Docs',
    to: '/docs/brokkr-overview',
  },
  {
    label: 'Inventory',
    to: '/inventory',
  },
  {
    label: 'Learn More',
    to: COMPANY_URL,
    external: true,
  },
];

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
            {navItems.map((item) => {
              const isCurrent = location.pathname.includes(item.to);

              if (item.external) {
                return (
                  <a
                    key={item.to}
                    href={item.to}
                    className={cn('bg-transparent', 'rounded-md px-3 py-2 text-sm font-semibold')}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.label}
                  </a>
                );
              }

              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    isCurrent ? 'bg-primary/10 text-primary' : 'bg-transparent',
                    'rounded-md px-3 py-2 text-sm font-semibold',
                  )}
                  preload="intent"
                >
                  {item.label}
                </Link>
              );
            })}
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
                {navItems.map((item) => {
                  const isCurrent = location.pathname.includes(item.to);

                  if (item.external) {
                    return (
                      <a
                        key={item.to}
                        href={item.to}
                        onClick={() => setMobileMenuOpen(false)}
                        className={cn(
                          'block rounded-md px-3 py-2 text-base font-semibold transition-colors',
                          'text-muted-foreground hover:bg-muted hover:text-white',
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.label}
                      </a>
                    );
                  }

                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileMenuOpen(false)}
                      className={cn(
                        'block rounded-md px-3 py-2 text-base font-semibold transition-colors',
                        isCurrent
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:bg-muted hover:text-white',
                      )}
                      preload="intent"
                    >
                      {item.label}
                    </Link>
                  );
                })}

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
