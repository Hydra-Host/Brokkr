import { useState } from 'react';

import { copyText } from '@/lib/clipboard';

export function CopyButton({ value, title = 'copy' }: { value: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void copyText(value).then((ok) => {
          if (ok) {
            setDone(true);
            setTimeout(() => setDone(false), 1000);
          }
        });
      }}
      title={title}
      className="text-text-dim hover:text-accent px-1 text-[11px]"
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}
