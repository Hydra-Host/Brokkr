import { describe, expect, it } from 'vitest';
import { renderFallbackGrub, renderGrubDefaults } from '../grub';

const CAPTURED_GRUB_TTY_S1 = `GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=5
GRUB_RECORDFAIL_TIMEOUT=5
GRUB_DISABLE_OS_PROBER=true
GRUB_CMDLINE_LINUX_DEFAULT=""
GRUB_CMDLINE_LINUX="quiet splash console=tty0 console=ttyS1,115200n8 earlyprintk=ttyS1,115200 earlycon=ttyS1,115200"
GRUB_SERIAL_COMMAND="serial --unit=1 --speed=115200 --word=8 --parity=no --stop=1"
GRUB_TERMINAL="console serial"
GRUB_SAVEDEFAULT=false`;

const GRUB_MINIMAL = `GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=5
GRUB_RECORDFAIL_TIMEOUT=5
GRUB_DISABLE_OS_PROBER=true
GRUB_CMDLINE_LINUX_DEFAULT=""
GRUB_CMDLINE_LINUX="quiet splash console=tty0"
GRUB_SAVEDEFAULT=false`;

const GRUB_GH200_ROCE_TTY = `GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=5
GRUB_RECORDFAIL_TIMEOUT=5
GRUB_DISABLE_OS_PROBER=true
GRUB_CMDLINE_LINUX_DEFAULT="memhp_default_state=online_movable"
GRUB_CMDLINE_LINUX="quiet splash iommu=pt nvidia-drm.modeset=0 console=tty0 console=ttyS1,115200n8 earlyprintk=ttyS1,115200 earlycon=ttyS1,115200 intel_iommu=on iommu=pt"
GRUB_SERIAL_COMMAND="serial --unit=1 --speed=115200 --word=8 --parity=no --stop=1"
GRUB_TERMINAL="console serial"
GRUB_SAVEDEFAULT=false`;

const GRUB_H100_PCI_REALLOC = `GRUB_DEFAULT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=5
GRUB_RECORDFAIL_TIMEOUT=5
GRUB_DISABLE_OS_PROBER=true
GRUB_CMDLINE_LINUX_DEFAULT=""
GRUB_CMDLINE_LINUX="quiet splash iommu=pt nvidia-drm.modeset=0 pci=realloc=off console=tty0"
GRUB_SAVEDEFAULT=false`;

describe('renderGrubDefaults', () => {
  it('reproduces captured production output (lc-test, ttyS1, no GPU, no RoCE)', () => {
    const out = renderGrubDefaults({
      grub: {
        gpuModel: undefined,
        pciReallocOff: false,
        serialPorts: { port: 'ttyS1' },
      } as never,
      roceIommu: false,
    });
    expect(out).toBe(CAPTURED_GRUB_TTY_S1);
  });

  it('renders the minimal vector (no GPU, no serial, no RoCE)', () => {
    const out = renderGrubDefaults({
      grub: {
        gpuModel: undefined,
        pciReallocOff: false,
        serialPorts: undefined,
      } as never,
      roceIommu: false,
    });
    expect(out).toBe(GRUB_MINIMAL);
  });

  it('renders the GH200 + RoCE + ttyS1 vector (every branch lit)', () => {
    const out = renderGrubDefaults({
      grub: {
        gpuModel: 'NVIDIA Grace Hopper GH200',
        pciReallocOff: false,
        serialPorts: { port: 'ttyS1' },
      } as never,
      roceIommu: true,
    });
    expect(out).toBe(GRUB_GH200_ROCE_TTY);
  });

  it('renders the H100 + PCI realloc vector (GPU without gh200, no serial)', () => {
    const out = renderGrubDefaults({
      grub: {
        gpuModel: 'NVIDIA H100 80GB',
        pciReallocOff: true,
        serialPorts: undefined,
      } as never,
      roceIommu: false,
    });
    expect(out).toBe(GRUB_H100_PCI_REALLOC);
  });

  it('detects gh200 case-insensitively', () => {
    for (const gpu of ['gh200', 'GH200', 'NVIDIA gh200 SXM']) {
      const out = renderGrubDefaults({
        grub: { gpuModel: gpu, pciReallocOff: false, serialPorts: undefined } as never,
        roceIommu: false,
      });
      expect(out).toContain('GRUB_CMDLINE_LINUX_DEFAULT="memhp_default_state=online_movable"');
    }
  });

  it('extracts the unit number from ttyS<N> serial port names', () => {
    const out = renderGrubDefaults({
      grub: {
        gpuModel: undefined,
        pciReallocOff: false,
        serialPorts: { port: 'ttyS3' },
      } as never,
      roceIommu: false,
    });
    expect(out).toContain('GRUB_SERIAL_COMMAND="serial --unit=3');
  });

  it('falls back to unit 0 for non-ttyS serial port names', () => {
    const out = renderGrubDefaults({
      grub: {
        gpuModel: undefined,
        pciReallocOff: false,
        serialPorts: { port: 'ttyUSB1' },
      } as never,
      roceIommu: false,
    });
    expect(out).toContain('GRUB_SERIAL_COMMAND="serial --unit=0');
  });
});

describe('renderFallbackGrub', () => {
  it('uses the x64 suffix for amd64 and never the arm64 one', () => {
    const out = renderFallbackGrub({ distro: 'ubuntu', arch: 'amd64' });
    expect(out).toContain('chainloader /EFI/$bootloader');
    expect(out).toContain('ubuntu/grubx64.efi');
    expect(out).not.toContain('grubaa64');
  });

  it('uses the aa64 suffix for arm64 and never the amd64 one', () => {
    const out = renderFallbackGrub({ distro: 'ubuntu', arch: 'arm64' });
    expect(out).toContain('ubuntu/grubaa64.efi');
    expect(out).not.toContain('grubx64');
  });

  it('tries the distro path first, then ubuntu/debian, then the on-disk grub.cfg', () => {
    const out = renderFallbackGrub({ distro: 'debian', arch: 'amd64' });
    expect(out).toContain("menuentry 'Chainload debian bootloader'");
    expect(out).toContain('debian/shimx64.efi');
    expect(out).toContain('debian/grubx64.efi');
    expect(out).toContain('configfile /boot/grub/grub.cfg');
    expect(out).not.toContain('chainloader /EFI/debian/grubx64.efi');
  });

  it('does not end with a trailing newline', () => {
    const out = renderFallbackGrub({ distro: 'ubuntu', arch: 'amd64' });
    expect(out.endsWith('\n')).toBe(false);
  });
});
