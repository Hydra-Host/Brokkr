import { BRAND_NAME } from '@/lib/branding';
import { docsSidebar } from '@/lib/docs-manifest';
import { cn } from '@repo/ui/utils';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  BookOpen,
  Building2,
  CircleHelp,
  Code2,
  Globe,
  Rocket,
  Server,
  Settings2,
  ShieldCheck,
  Warehouse,
} from 'lucide-react';

export const Route = createFileRoute('/_docs/')({
  component: DocsLanding,
});

const SECTION_ICONS: Record<string, LucideIcon> = {
  about: BookOpen,
  'get-started': Rocket,
  'self-host': Server,
  zones: Warehouse,
  network: Globe,
  infrastructure: Building2,
  organizations: Settings2,
  deployments: ShieldCheck,
  api: Code2,
  help: CircleHelp,
};

function firstSlug(sectionKey: string): string | undefined {
  return docsSidebar.find((s) => s.key === sectionKey)?.items[0]?.slug;
}

function DocsLanding() {
  const selfHostSlug = firstSlug('self-host');
  const apiSlug = firstSlug('api');
  const simLabSlug = docsSidebar
    .find((s) => s.key === 'get-started')
    ?.items.find((i) => i.slug.includes('sim-lab'))?.slug;

  return (
    <div>
      {/* Hero */}
      <header className="border-border border-b pb-12">
        <p className="text-primary text-sm font-semibold tracking-wide uppercase">Documentation</p>
        <h1 className="text-foreground mt-3 text-4xl font-bold tracking-tight">Run bare metal like a cloud.</h1>
        <p className="text-foreground/90 mt-4 max-w-4xl text-lg leading-relaxed">
          {BRAND_NAME} is an open-source platform for provisioning and managing bare metal. Brokkr (the hub) drives a
          Bridge in each zone that controls your machines over IPMI and Redfish and network-boots them into service.
          These docs cover everything from first deployment to API automation.
        </p>
      </header>

      {/* Primary CTAs */}
      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {simLabSlug && (
          <Link
            to="/$"
            params={{ _splat: simLabSlug }}
            className={cn(
              'group border-border relative overflow-hidden rounded-lg border p-6 transition-all duration-200',
              'hover:border-primary/50 hover:shadow-lg',
            )}
          >
            <Rocket className="text-primary mb-4 h-6 w-6" />
            <h2 className="text-foreground text-lg font-semibold">Try it without hardware</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              Run the full platform on a laptop against a simulated fleet and replay the whole lifecycle in one click.
            </p>
            <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
              The sim lab
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
            </span>
          </Link>
        )}
        {selfHostSlug && (
          <Link
            to="/$"
            params={{ _splat: selfHostSlug }}
            className={cn(
              'group border-border relative overflow-hidden rounded-lg border p-6 transition-all duration-200',
              'hover:border-primary/50 hover:shadow-lg',
            )}
          >
            <Server className="text-primary mb-4 h-6 w-6" />
            <h2 className="text-foreground text-lg font-semibold">Self-host {BRAND_NAME}</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              Deploy the hub and your first bridge with Docker Compose, enroll a zone, and provision your first machine.
            </p>
            <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
              Get started
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
            </span>
          </Link>
        )}
        {apiSlug && (
          <Link
            to="/$"
            params={{ _splat: apiSlug }}
            className={cn(
              'group border-border relative overflow-hidden rounded-lg border p-6 transition-all duration-200',
              'hover:border-primary/50 hover:shadow-lg',
            )}
          >
            <Code2 className="text-primary mb-4 h-6 w-6" />
            <h2 className="text-foreground text-lg font-semibold">Automate with the API</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              Authenticate, manage inventory and deployments, and wire up webhooks against the REST API.
            </p>
            <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
              API reference
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
            </span>
          </Link>
        )}
      </div>

      {/* Section index */}
      <div className="mt-14 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {docsSidebar.map((section) => {
          const Icon = SECTION_ICONS[section.key] ?? BookOpen;
          return (
            <section
              key={section.key}
              className="border-border hover:border-primary/40 rounded-lg border p-6 transition-colors duration-200"
            >
              <div className="mb-4 flex items-center gap-2">
                <Icon className="text-primary h-4 w-4" />
                <h3 className="text-foreground text-sm font-semibold tracking-wide uppercase">{section.label}</h3>
              </div>
              <ul className="space-y-2.5">
                {section.items.map((item) => (
                  <li key={item.slug}>
                    <Link
                      to="/$"
                      params={{ _splat: item.slug }}
                      className="text-muted-foreground hover:text-primary text-sm leading-snug transition-colors duration-150"
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
