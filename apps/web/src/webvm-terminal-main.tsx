import { type BrokkrCommandHandler, TerminalWindow } from '@hydrahost/plugin-webvm-terminal/terminal';
import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';

import { BRAND_NAME } from '@/lib/branding';
import { claimNavPopupLock } from '@/lib/nav';

import './brokkr.css';

// The branding Vite plugin rewrites every HTML <title> to the bare brand name;
// re-qualify it here so the popup window is identifiable in the taskbar.
document.title = `${BRAND_NAME} Linux Terminal`;

// Entry for the /webvm-terminal popup — the only page served with COOP/COEP; it
// only wires the browser CLI bundle into the plugin-owned terminal.

const handleBrokkrCommand: BrokkrCommandHandler = (args, write, options) => {
  // A handle must be returned synchronously, but the CLI bundle loads async.
  // Return a deferred handle that delegates once the module resolves.
  let resolvedSendInput: ((data: string) => void) | null = null;
  let resolvedKill: (() => void) | null = null;
  // A kill during the async import must stick, or the command would run headless
  // and `done` would never settle — leaving output suppression on forever.
  let killed = false;
  const done = import('@repo/cli/browser').then(({ runBrokkrCommand }) => {
    if (killed) return;
    const handle = runBrokkrCommand(args, write, options);
    resolvedSendInput = handle.sendInput;
    resolvedKill = handle.kill;
    return handle.done;
  });
  return {
    done,
    sendInput: (data: string) => resolvedSendInput?.(data),
    kill: () => {
      killed = true;
      resolvedKill?.();
    },
  };
};

const handleGetBashCompletion = async () => {
  const mod = await import('@repo/cli/browser');
  return mod.getBashCompletionScript();
};

// The lock claim resolves BEFORE React mounts, or two windows could open the shared
// 'brokkr-linux-overlay' IndexedDB device concurrently — two writers on one overlay.
const rootElement = document.getElementById('root');
if (rootElement && !rootElement.innerHTML) {
  void claimNavPopupLock().then((granted) => {
    if (!granted) {
      window.close();
      // window.close() can be refused (e.g. a user-opened tab); leave a note
      // instead of a dead blank page. Never boot a second VM here.
      rootElement.textContent = 'The Linux Terminal is already open in another window.';
      return;
    }
    ReactDOM.createRoot(rootElement).render(
      <StrictMode>
        <TerminalWindow onCommand={handleBrokkrCommand} getBashCompletion={handleGetBashCompletion} />
      </StrictMode>,
    );
  });
}
