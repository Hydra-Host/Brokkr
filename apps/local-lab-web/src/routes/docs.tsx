import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { useTheme } from '@/components/ui/theme';
import { withLabToken } from '@/lib/lab-token';

const TABS = [
  { id: 'redoc', label: 'ReDoc', src: '/api/redoc' },
  { id: 'swagger', label: 'Swagger', src: '/api/swagger' },
] as const;

function DocsPage() {
  const { theme } = useTheme();
  const [tab, setTab] = useState<string>(TABS[0].id);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  // an iframe cannot send the token header, so the guarded docs routes need it on the query string.
  const src = withLabToken(`${active.src}?theme=${encodeURIComponent(theme)}`);

  return (
    <div className="flex h-full flex-col">
      <div className="border-border-dim flex shrink-0 items-center gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              '-mb-px border-b-2 px-3 py-2 text-sm transition',
              tab === t.id
                ? 'border-accent text-text-primary'
                : 'text-text-dim hover:text-text-muted border-transparent',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <iframe
        key={`${active.id}:${theme}`}
        src={src}
        title={active.label}
        width="100%"
        className="flex-1 border-0"
        style={{ border: 'none' }}
      />
    </div>
  );
}

export const Route = createFileRoute('/docs')({ component: DocsPage });
