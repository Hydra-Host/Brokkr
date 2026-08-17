import { initClient } from '@ts-rest/core';
import { useEffect, useState } from 'react';

import { contractFragment } from '../contract';

const client = initClient(contractFragment, { baseUrl: '', baseHeaders: {} });

type Greeting = { id?: string; message?: string; createdAt?: Date };

export function GreetingWidget({ pluginId }: { pluginId: string }) {
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
    <div
      style={{
        border: '1px solid var(--border, #d4d4d8)',
        borderRadius: '0.5rem',
        padding: '1rem',
        background: 'var(--card, #fafafa)',
        color: 'var(--card-foreground, #18181b)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <span
          style={{
            fontSize: '0.6875rem',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            opacity: 0.6,
          }}
        >
          plugin · {pluginId}
        </span>
      </div>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0, marginBottom: '0.5rem' }}>Greetings</h3>
      {error ? (
        <p style={{ color: 'crimson', fontSize: '0.875rem', margin: 0 }}>Failed to load: {error}</p>
      ) : greetings === null ? (
        <p style={{ fontSize: '0.875rem', opacity: 0.6, margin: 0 }}>Loading…</p>
      ) : greetings.length === 0 ? (
        <p style={{ fontSize: '0.875rem', opacity: 0.6, margin: 0 }}>No greetings yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
          {greetings.map((g) => (
            <li key={g.id} style={{ fontSize: '0.875rem' }}>
              {g.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
