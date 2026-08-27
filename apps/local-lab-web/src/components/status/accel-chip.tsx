import type { FleetStatus } from '@/contract';

const FORCED_HINT =
  'An explicit LOCAL_ACCEL=tcg setting chose emulation — the host was never asked for KVM. Boot and OS install run 5 to 20 times slower. Unset LOCAL_ACCEL to auto-detect the accelerator again.';

const PROBED_HINT =
  'KVM is not available, so every CPU instruction is emulated in software. Boot and OS install run 5 to 20 times slower. Enable nested virtualization on the hypervisor, or add the libvirt qemu user to the group owning /dev/kvm. A running VM keeps its accelerator — a repair applies on the next cold cycle.';

const UNKNOWN_HINT =
  'This fleet emulates every CPU instruction in software, so boot and OS install run 5 to 20 times slower. The engine did not record whether a setting chose this or the host refused KVM.';

// Emulation is slow, not broken, so this is amber and fleet health stays `ready`. A null
// accelForced is genuinely unknown — naming a cause there would be a guess, not a measurement.
export function AccelChip({ fleet }: { fleet: Pick<FleetStatus, 'accel' | 'accelForced'> }) {
  if (fleet.accel !== 'tcg') return null;
  const { label, hint } =
    fleet.accelForced == null
      ? { label: 'emulated', hint: UNKNOWN_HINT }
      : fleet.accelForced
        ? { label: 'emulated · forced', hint: FORCED_HINT }
        : { label: 'emulated · no KVM', hint: PROBED_HINT };
  return (
    <span
      title={hint}
      className="border-status-warning/60 bg-status-warning/15 text-status-warning shrink-0 cursor-help rounded border px-1.5 py-px text-[10px] font-medium"
    >
      {label}
    </span>
  );
}
