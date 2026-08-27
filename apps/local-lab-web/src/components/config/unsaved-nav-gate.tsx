import { useBlocker } from '@tanstack/react-router';

import { GateModal } from '@/components/console';
import { blocksUnsavedNav } from '@/lib/unsaved-nav';

/** Leaving the route unmounts the editor, so unsaved edits need explicit consent to be dropped. Shared
 *  rather than per-page: a config page that forgets to render this loses edits with no warning. */
export function UnsavedNavGate({ dirty, what }: { dirty: boolean; what: string }) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => blocksUnsavedNav(dirty, current.pathname, next.pathname),
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  if (blocker.status !== 'blocked') return null;
  return (
    <GateModal
      gate={{
        label: `Leave with unsaved ${what} edits`,
        destructive: true,
        description: `Your unsaved ${what} edits are dropped when you leave this page.`,
        needsPassword: false,
        password: '',
        setPassword: () => {},
        error: '',
        busy: false,
        confirmLabel: 'Discard and leave',
        confirm: blocker.proceed,
        cancel: blocker.reset,
      }}
      fixed
    />
  );
}
