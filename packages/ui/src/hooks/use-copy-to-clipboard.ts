import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const DEFAULT_KEY = '__default__';

export function useCopyToClipboard(timeoutMs = 2000): {
  copy: (value: string, key?: string) => Promise<void>;
  copied: boolean;
  copiedKey: string | null;
  reset: () => void;
} {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearPending, [clearPending]);

  const reset = useCallback(() => {
    clearPending();
    setCopiedKey(null);
  }, [clearPending]);

  const copy = useCallback(
    async (value: string, key: string = DEFAULT_KEY) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch (error) {
        console.error('Clipboard write failed:', error);
        toast.error('Failed to copy to clipboard');
        return;
      }
      clearPending();
      setCopiedKey(key);
      timeoutRef.current = setTimeout(() => setCopiedKey(null), timeoutMs);
    },
    [clearPending, timeoutMs],
  );

  return { copy, copied: copiedKey !== null, copiedKey, reset };
}
