import { createFileRoute, Link } from '@tanstack/react-router';

import { usePluginRegistry } from '~/plugin-host';

export const Route = createFileRoute('/_app/plugins/')({
  component: PluginsIndex,
});

function PluginsIndex() {
  const registry = usePluginRegistry();
  const routes = [...registry.routes.values()];

  return (
    <div style={{ padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.25rem' }}>Plugins</h1>
      <p style={{ marginBottom: '1.5rem', opacity: 0.7, fontSize: '0.875rem' }}>
        Installed plugins that contribute a root page.
      </p>
      {routes.length === 0 ? (
        <p style={{ fontSize: '0.875rem', opacity: 0.6, margin: 0 }}>
          No plugins with root routes are installed. Plugins that only contribute slot widgets or backend functionality
          appear elsewhere.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: '0.75rem',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          }}
        >
          {routes.map(({ pluginId, route }) => (
            <li key={pluginId}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId }}
                style={{
                  display: 'block',
                  border: '1px solid var(--border, #d4d4d8)',
                  borderRadius: '0.5rem',
                  padding: '1rem',
                  background: 'var(--card, #fafafa)',
                  color: 'inherit',
                  textDecoration: 'none',
                  fontFamily: 'system-ui, sans-serif',
                }}
              >
                <div
                  style={{
                    fontSize: '0.6875rem',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    opacity: 0.6,
                    marginBottom: '0.25rem',
                  }}
                >
                  plugin · {pluginId}
                </div>
                <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>{route.label}</div>
                {route.description && <div style={{ fontSize: '0.8125rem', opacity: 0.7 }}>{route.description}</div>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
