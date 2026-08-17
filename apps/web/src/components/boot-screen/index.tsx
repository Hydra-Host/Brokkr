import { useState } from 'react';

import { BiosBootScreen } from './bios-boot';
import { LinuxBootScreen } from './linux-boot';
import { SystemdBootScreen } from './systemd-boot';

const VARIANTS = [BiosBootScreen, LinuxBootScreen, SystemdBootScreen];

export function BootScreen() {
  const [Component] = useState(() => VARIANTS[Math.floor(Math.random() * VARIANTS.length)]);
  return <Component />;
}
