import { BRAND_NAME } from '@/lib/branding';
import { Button } from '@repo/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/sheet';
import { cn } from '@repo/ui/utils';
import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import { BookOpenText, Menu } from 'lucide-react';
import { useState } from 'react';
import { DocPage } from './_components/-docs-page';

const sidebarItems = [
  {
    title: `Introduction to ${BRAND_NAME}`,
    items: [
      {
        title: `${BRAND_NAME} Overview`,
        href: '/docs/brokkr-overview',
      },
      {
        title: `${BRAND_NAME} Components`,
        href: '/docs/brokkr-components',
      },
      {
        title: `${BRAND_NAME} Terms of Service`,
        href: '/docs/brokkr-tos',
      },
    ],
  },
  {
    title: `${BRAND_NAME} API`,
    items: [
      {
        title: 'Overview',
        href: '/docs/brokkr-api-overview',
      },
      {
        title: 'Authentication',
        href: '/docs/brokkr-api-authentication',
      },
      {
        title: 'DCIM',
        href: '/docs/brokkr-api-dcim',
      },
      {
        title: 'Deployments',
        href: '/docs/brokkr-api-deployments',
      },
      {
        title: 'Inventory',
        href: '/docs/brokkr-api-inventory',
      },
      {
        title: 'Reservations',
        href: '/docs/brokkr-api-reservations',
      },
      {
        title: 'Webhooks',
        href: '/docs/brokkr-api-webhooks',
      },
    ],
  },
  {
    title: `${BRAND_NAME} Bridge`,
    items: [
      {
        title: 'Installation Overview',
        href: '/docs/installation-overview',
      },
    ],
  },
  {
    title: `${BRAND_NAME} Security`,
    items: [
      {
        title: `${BRAND_NAME} Security Documentation`,
        href: '/docs/brokkr-security',
      },
      {
        title: `${BRAND_NAME} Multi-Factor Authentication`,
        href: '/docs/brokkr-mfa',
      },
      {
        title: 'Disk Encryption',
        href: '/docs/disk-encryption',
      },
    ],
  },
  {
    title: `${BRAND_NAME} FAQ`,
    items: [
      {
        title: 'SSH Connectivity on VPN',
        href: '/docs/ssh-stops-on-vpn',
      },
      {
        title: `SSH Keys with ${BRAND_NAME}`,
        href: '/docs/ssh-keys-with-brokkr',
      },
      {
        title: 'Troubleshooting NVIDIA SMI',
        href: '/docs/nvidia-smi-not-working',
      },
      {
        title: 'NVIDIA Driver and CUDA Toolkit',
        href: '/docs/nvidia-driver-and-cuda-toolkit',
      },
      {
        title: 'Trusted Execution Environment',
        href: '/docs/tee-environment',
      },
    ],
  },
];

export const Route = createFileRoute('/_navbar-layout/docs')({
  component: DocsLayout,
  staticData: {
    breadcrumb: 'Documentation',
    description: `From renting GPUs to managing datacenters, the ${BRAND_NAME} platform has a wide variety of useful features and integrations.`,
  },
});

function DocsLayout() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="container mx-auto">
      <div className="mb-8 md:mb-12">
        <div className="mb-4 flex flex-row items-start justify-end gap-4 lg:hidden">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger className="border-border bg-bg-primary hover:bg-accent/10 hover:text-text-primary inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors">
              <Menu className="h-4 w-4" />
              <span>View All Docs</span>
            </SheetTrigger>
            <SheetContent side="right" className="w-full max-w-xs overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Docs Menu</SheetTitle>
                <SheetDescription>Browse documentation topics</SheetDescription>
              </SheetHeader>

              <nav className="mt-6 space-y-6">
                {sidebarItems.map((section) => (
                  <div key={section.title}>
                    <h3 className="text-foreground mb-3 text-sm font-bold">{section.title}</h3>

                    <div className="space-y-1">
                      {section.items.map((item) => {
                        const isActive = location.pathname === item.href;

                        return (
                          <Link
                            key={item.title}
                            to={item.href}
                            onClick={() => setMobileMenuOpen(false)}
                            className={cn(
                              'block rounded-md px-3 py-2 text-sm transition-colors',
                              isActive
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                            )}
                          >
                            {item.title}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="border-border border-t pt-6">
                  <Button asChild className="w-full">
                    <a
                      href="/api/redoc"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2"
                    >
                      <BookOpenText className="h-4 w-4" />
                      View API Reference
                    </a>
                  </Button>
                </div>
              </nav>
            </SheetContent>
          </Sheet>
        </div>

        <div className="hidden items-start lg:flex">
          <Button asChild>
            <a href="/api/redoc" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
              <BookOpenText className="h-4 w-4" />
              View API Reference
            </a>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 pt-4 md:pt-6 lg:grid-cols-4 lg:gap-16">
        <div className="border-border hidden border-r lg:col-span-1 lg:block">
          <nav className="sticky top-28 max-h-[calc(100vh-12rem)] space-y-6 overflow-y-auto pr-8">
            {sidebarItems.map((section) => (
              <div key={section.title}>
                <h3 className="text-foreground text-sm font-bold">{section.title}</h3>

                <div className="py-2">
                  {section.items.map((item) => {
                    const isActive = location.pathname === item.href;

                    return (
                      <div
                        key={item.title}
                        className={cn('border-border border-l-2 py-2 pl-4', isActive && 'border-primary')}
                      >
                        <Link
                          to={item.href}
                          className={cn(
                            'text-muted-foreground hover:text-foreground block text-sm',
                            isActive && 'text-primary',
                          )}
                        >
                          {item.title}
                        </Link>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </div>

        <div className="col-span-1 lg:col-span-2">
          <Outlet />
        </div>

        <div className="hidden md:block lg:col-span-1">
          <DocPage.TableOfContents />
        </div>
      </div>
    </div>
  );
}
