import { initClient } from '@ts-rest/core';
import { useEffect, useState } from 'react';

import { contractFragment } from '../contract';

const client = initClient(contractFragment, { baseUrl: '', baseHeaders: {} });

type Greeting = { id?: string; message?: string; createdAt?: Date };

export function HelloWorldPage({ pluginId, splat }: { pluginId: string; splat: string }) {
  const view = splat === '' ? 'overview' : splat === 'about' ? 'about' : 'unknown';

  return (
    <div style={{ padding: '1.5rem', maxWidth: '64rem', fontFamily: 'system-ui, sans-serif' }}>
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
        {splat && (
          <>
            <span style={{ margin: '0 0.5rem', opacity: 0.4 }}>·</span>
            <code style={{ opacity: 0.7 }}>/{splat}</code>
          </>
        )}
      </div>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 700, margin: 0, marginBottom: '1rem' }}>Hello World</h1>

      <nav style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
        <SubNavLink pluginId={pluginId} splat="" current={splat}>
          Overview
        </SubNavLink>
        <SubNavLink pluginId={pluginId} splat="about" current={splat}>
          About
        </SubNavLink>
      </nav>

      {view === 'overview' && <OverviewView />}
      {view === 'about' && <AboutView />}
      {view === 'unknown' && <UnknownView splat={splat} />}
    </div>
  );
}

function SubNavLink({
  pluginId,
  splat,
  current,
  children,
}: {
  pluginId: string;
  splat: string;
  current: string;
  children: React.ReactNode;
}) {
  const isActive = current === splat;
  const href = splat === '' ? `/plugins/${pluginId}` : `/plugins/${pluginId}/${splat}`;
  return (
    <a
      href={href}
      style={{
        color: 'inherit',
        textDecoration: 'none',
        padding: '0.25rem 0.5rem',
        borderRadius: '0.25rem',
        background: isActive ? 'var(--accent, rgba(0,0,0,0.06))' : 'transparent',
        fontWeight: isActive ? 600 : 400,
      }}
    >
      {children}
    </a>
  );
}

function OverviewView() {
  const [greetings, setGreetings] = useState<Greeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .helloWorldListGreetings()
      .then((res) => {
        if (cancelled) return;
        if (res.status === 200) setGreetings(res.body);
        else setError(`HTTP ${res.status}`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <p style={{ opacity: 0.7, fontSize: '0.9375rem', marginBottom: '1.5rem', lineHeight: 1.5 }}>
        The greetings below come from the plugin's own Postgres schema (<code>plugin_hello_world.greetings</code>) via
        the plugin's own ts-rest endpoint at <code>/api/v1/plugins/hello-world/greetings</code>.
      </p>
      <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0, marginBottom: '0.75rem' }}>Greetings</h2>
      {error ? (
        <p style={{ color: 'crimson', fontSize: '0.875rem', margin: 0 }}>Failed to load: {error}</p>
      ) : greetings === null ? (
        <p style={{ fontSize: '0.875rem', opacity: 0.6, margin: 0 }}>Loading…</p>
      ) : greetings.length === 0 ? (
        <p style={{ fontSize: '0.875rem', opacity: 0.6, margin: 0 }}>No greetings recorded yet.</p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            border: '1px solid var(--border, #d4d4d8)',
            borderRadius: '0.5rem',
            overflow: 'hidden',
          }}
        >
          {greetings.map((g, i) => (
            <li
              key={g.id}
              style={{
                padding: '0.75rem 1rem',
                borderTop: i === 0 ? 'none' : '1px solid var(--border, #d4d4d8)',
                fontSize: '0.9375rem',
              }}
            >
              {g.message}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AboutView() {
  return (
    <div style={{ lineHeight: 1.6 }}>
      <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0, marginBottom: '0.75rem' }}>About this plugin</h2>
      <p style={{ opacity: 0.7, fontSize: '0.9375rem' }}>
        <code>@hydrahost/plugin-hello-world</code> is the reference plugin for Brokkr's plugin system. It exercises
        every layer of the contract:
      </p>
      <ul style={{ opacity: 0.7, fontSize: '0.9375rem', paddingLeft: '1.5rem' }}>
        <li>
          Database — owns the <code>plugin_hello_world</code> Postgres schema with a SQL migration.
        </li>
        <li>Backend — NestJS module with a Zod-validated service.</li>
        <li>Contract — ts-rest fragment merged into the host's OpenAPI.</li>
        <li>
          Config — typed <code>messagePrefix</code> setting injected via <code>getPluginConfigToken</code>.
        </li>
        <li>Frontend — slot widget (dashboard) + sidebar nav entry + this root route.</li>
        <li>
          Sub-routes — the page you're on (<code>/about</code>) is a splat-driven sub-view.
        </li>
      </ul>
      <p style={{ opacity: 0.7, fontSize: '0.9375rem' }}>
        Read the source at <code>packages/plugins/hello-world/</code> to see the full pattern.
      </p>
    </div>
  );
}

function UnknownView({ splat }: { splat: string }) {
  return (
    <div
      style={{
        padding: '1rem',
        border: '1px dashed var(--border, #d4d4d8)',
        borderRadius: '0.5rem',
        fontSize: '0.875rem',
      }}
    >
      No view registered for sub-path <code>/{splat}</code>. The hello-world plugin only handles <code>/</code> and{' '}
      <code>/about</code> internally.
    </div>
  );
}
