import type { BootReadinessFinding } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { cn } from '@repo/ui/utils';
import { BOOT_CODES, type BootSeverity, PREFIX_FINDING_CODES } from '@repo/utils';
import { Link } from '@tanstack/react-router';
import { useDiagnosticsApi } from '../hooks/use-diagnostics-api';

const SEVERITY_VARIANT: Record<BootSeverity, 'destructive' | 'warning' | 'info'> = {
  error: 'destructive',
  warn: 'warning',
  info: 'info',
};

function PrefixLink({ prefixId }: { prefixId: string }) {
  const { hrefs } = useDiagnosticsApi();
  const href = hrefs.prefix(prefixId);
  // an app without a prefix page still names the prefix so the operator can find it in the hub
  if (href === null) return <p className="text-muted-foreground font-mono text-xs">prefix {prefixId}</p>;
  return (
    <Link to={href} className="text-sm underline">
      Open prefix DHCP settings
    </Link>
  );
}

export function BootFindingList({
  findings,
  bootExpected,
  canOpenPrefix,
  emptyText,
}: {
  findings: BootReadinessFinding[];
  bootExpected: boolean | null;
  canOpenPrefix: boolean;
  emptyText: string;
}) {
  if (findings.length === 0) return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  // null means the expectation is unknown, so the severity style stays
  const dormant = bootExpected === false;
  return (
    <ul className="space-y-3">
      {findings.map((finding) => {
        const spec = BOOT_CODES[finding.code];
        const prefixId = finding.prefixId;
        const linkable = canOpenPrefix && prefixId !== null && PREFIX_FINDING_CODES.includes(finding.code);
        return (
          <li
            key={`${finding.code}-${finding.source}-${finding.message}`}
            className={cn('border-l-2 pl-3', dormant && 'text-muted-foreground')}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={dormant ? 'outline' : SEVERITY_VARIANT[finding.severity]}>{finding.code}</Badge>
              <span className="font-medium">{spec.title}</span>
            </div>
            <p className="text-muted-foreground text-sm">{finding.message}</p>
            <p className="text-sm">{spec.remedy}</p>
            {linkable && prefixId !== null && <PrefixLink prefixId={prefixId} />}
          </li>
        );
      })}
    </ul>
  );
}
