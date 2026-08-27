import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ApplyPanel } from '@/components/config/apply-panel';
import { ConfigDirtyProvider } from '@/lib/config-dirty';

/** Layout for every /config page. What is outstanding is server-side and identical on all of them, so
 *  it is answered — and applied — once here; each page keeps its own save control for its own form. */
function ConfigLayout() {
  return (
    <ConfigDirtyProvider>
      <div className="space-y-4">
        <ApplyPanel />
        <Outlet />
      </div>
    </ConfigDirtyProvider>
  );
}

export const Route = createFileRoute('/config')({ component: ConfigLayout });
