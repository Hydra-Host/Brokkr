import { defineFrontendModule } from '@hydrahost/plugin-sdk';

import { TerminalIcon } from './terminal-icon';

// popup: true — SharedArrayBuffer needs a cross-origin-isolated (COOP/COEP) document,
// which the main app deliberately does not carry (COEP breaks payment iframes).
export default defineFrontendModule({
  slots: {
    'sidebar-nav': [
      {
        label: 'Linux Terminal',
        to: '/webvm-terminal',
        popup: true,
        section: 'Terminal',
        icon: TerminalIcon,
        sectionIcon: TerminalIcon,
      },
    ],
  },
});
