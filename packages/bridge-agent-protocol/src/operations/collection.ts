import { z } from 'zod';

export const DEFAULT_COLLECTORS = [
  'architecture',
  'version',
  'efi',
  'ip',
  'is_virtual',
  'lshw',
  'lstopo',
  'lldp',
  'bdi',
  'lsblk',
  'lscpu',
  'public_ip',
  'route',
  'virtualization',
  'bmc',
  'ghw',
  'ib_data',
  'nvidia',
  'dmidecode',
  'efibootmgr',
  'memory',
  'kernel_params',
  'nvidia_detailed',
  'serial_ports',
  'secure_boot',
] as const;
export type DefaultCollector = (typeof DEFAULT_COLLECTORS)[number];

export const collectAll = {
  input: z.object({
    collectors: z
      .array(z.string())
      .optional()
      .describe(
        'Explicit collector subset to run. Omit to run DEFAULT_COLLECTORS. Unknown names produce a collection.result with status=failure.',
      ),
  }),
  output: z.object({
    collectors_run: z.array(z.string()).describe('Collector names actually dispatched, in registration order.'),
    successes: z.number().int().nonnegative().describe('Count of collectors that emitted status=success.'),
    failures: z.number().int().nonnegative().describe('Count of collectors that emitted status=failure.'),
    total_duration_ms: z
      .number()
      .int()
      .nonnegative()
      .describe('Wall-clock duration from dispatch start to last result.'),
  }),
} as const;

export const architecture = {
  input: z.object({}),
  output: z.object({
    architecture: z
      .object({
        machine: z.string().describe("Kernel-reported machine architecture, e.g. 'x86_64', 'aarch64'."),
      })
      .describe('Wrapper preserved for Python parity; matches the hub-consumed shape.'),
  }),
} as const;

export const version = {
  input: z.object({}),
  output: z.object({
    version: z.object({
      collector_version: z
        .string()
        .describe('Agent version string. The bridge overlays its own __version__ here for Python-path parity.'),
      iso_version: z.string().optional().describe('brokkr-live ISO version, when detectable from disk metadata.'),
    }),
  }),
} as const;

export const efi = {
  input: z.object({}),
  output: z.object({
    firmware_type: z
      .enum(['efi', 'bios'])
      .describe("Top-level shortcut: 'efi' iff /sys/firmware/efi exists, else 'bios'."),
    efi: z.object({
      detected: z.boolean().describe('Duplicates firmware_type === "efi"; preserved for Python-path hub consumers.'),
    }),
  }),
} as const;

export const ip = {
  input: z.object({}),
  output: z.object({
    ip_a: z.unknown().describe('Unmodified `ip --json a` output; opaque to the hub-facing layer.'),
  }),
} as const;

export const is_virtual = {
  input: z.object({}),
  output: z.object({
    is_virtual: z.boolean().describe("True iff systemd-detect-virt returned anything other than 'none'."),
    virt_type: z.string().describe("systemd-detect-virt output string, e.g. 'kvm', 'vmware', or 'none'."),
  }),
} as const;

export const lshw = {
  input: z.object({}),
  output: z.object({
    lshw: z.unknown().describe('Unmodified `lshw -json` output; deeply nested, opaque to this layer.'),
  }),
} as const;

export const lstopo = {
  input: z.object({}),
  output: z.object({
    lstopo: z
      .unknown()
      .describe(
        '`lstopo-no-graphics --of xml --whole-system` piped through `jc --xml`. Full hwloc topology — NUMA, caches, PCI bus / bridges, I/O devices. Deeply nested, opaque to this layer.',
      ),
  }),
} as const;

export const lldp = {
  input: z.object({}),
  output: z.object({
    lldp: z
      .unknown()
      .describe('lldpctl JSON output or a graceful-degradation stub { status, error? }. Opaque to this layer.'),
  }),
} as const;

export const bdi = {
  input: z.object({}),
  output: z.object({
    bdi: z
      .record(z.string(), z.string())
      .describe('Kernel cmdline parameters whose key starts with `bdi.`; values always kept as strings.'),
  }),
} as const;

export const lsblk = {
  input: z.object({}),
  output: z.object({
    lsblk: z.unknown().describe('Filtered `lsblk -J` output (loop/sr excluded). Opaque to this layer.'),
  }),
} as const;

export const lscpu = {
  input: z.object({}),
  output: z.object({
    lscpu: z.object({
      total_cpu_sockets: z.number().int().nonnegative().describe('Total CPU socket count.'),
      total_cpu_cores: z.number().int().nonnegative().describe('Total physical core count across all sockets.'),
      total_cpu_threads: z.number().int().nonnegative().describe('Total hardware thread count (cores × SMT).'),
      per_cpu_cores: z.number().int().nonnegative().describe('Cores per socket.'),
      per_cpu_threads: z.number().int().nonnegative().describe('Threads per socket.'),
      cpu_family: z.string().nullable().describe('x86 CPU family number as a string, or null if unreported.'),
      cpu_model: z.string().nullable().describe('x86 CPU model identifier as a string, or null if unreported.'),
    }),
  }),
} as const;

export const public_ip = {
  input: z.object({
    check_url: z.string().url().optional().describe('Optional override for the HTTPS check endpoint.'),
  }),
  output: z.object({
    public_ip: z.object({
      ipv4: z.string().nullable().describe('Observed public IPv4, or null when the probe failed.'),
      ipv6: z.string().nullable().describe('Observed public IPv6, or null when the probe failed.'),
      check_url: z.string().describe('The URL actually used for the probe.'),
    }),
  }),
} as const;

export const route = {
  input: z.object({}),
  output: z.object({
    route: z
      .array(
        z.object({
          destination: z.string().describe('Destination network/host.'),
          gateway: z.string().describe('Next-hop gateway.'),
          genmask: z.string().describe('Generic netmask.'),
          flags: z.string().describe('Raw routing flags, e.g. "UG", "UH".'),
          flags_pretty: z.array(z.string()).describe('Flags expanded to human-readable labels.'),
          metric: z.number().int().describe('Routing metric.'),
          ref: z.number().int().describe('Reference count.'),
          use: z.number().int().describe('Usage count.'),
          iface: z.string().describe('Interface name.'),
        }),
      )
      .describe('Routing table entries, matching the jc-parsed route shape for Python parity.'),
  }),
} as const;

export const virtualization = {
  input: z.object({}),
  output: z.object({
    virtualization: z.object({
      hypervisor_enabled: z
        .boolean()
        .nullable()
        .describe('True iff CPU flags include hypervisor extensions (vmx/svm); null if detection failed.'),
      iommu_groups_enabled: z
        .boolean()
        .nullable()
        .describe('True iff /sys/kernel/iommu_groups/ has populated entries; null if detection failed.'),
      sriov_bios_enabled: z
        .boolean()
        .nullable()
        .describe('True iff dmesg reports SR-IOV enabled; null if detection failed (e.g. dmesg restricted).'),
    }),
  }),
} as const;

export const bmc = {
  input: z.object({}),
  output: z.object({
    bmc: z.object({
      ipv4: z.string().nullable().describe('BMC IPv4 address; null when absent or the probe failed.'),
      mac: z.string().nullable().describe('BMC MAC address; null when absent or the probe failed.'),
      ipv6: z.string().nullable().describe('BMC IPv6 address; null when absent or the probe failed.'),
      status: z
        .enum(['no_device', 'error'])
        .optional()
        .describe('Graceful-degradation marker when the probe could not run.'),
      error: z.string().optional().describe('Error text when status === "error".'),
    }),
  }),
} as const;

export const ghw = {
  input: z.object({}),
  output: z.object({
    ghw_baseboard: z.unknown().nullable().describe('ghwc baseboard output; null when ghwc not present.'),
    ghw_bios: z.unknown().nullable().describe('ghwc bios output; null when ghwc not present.'),
    ghw_block: z.unknown().nullable().describe('ghwc block output; null when ghwc not present.'),
    ghw_chassis: z.unknown().nullable().describe('ghwc chassis output; null when ghwc not present.'),
    ghw_cpu: z.unknown().nullable().describe('ghwc cpu output; null when ghwc not present.'),
    ghw_gpu: z.unknown().nullable().describe('ghwc gpu output; null when ghwc not present.'),
    ghw_memory: z.unknown().nullable().describe('ghwc memory output; null when ghwc not present.'),
    ghw_net: z.unknown().nullable().describe('ghwc net output; null when ghwc not present.'),
    ghw_pci: z.unknown().nullable().describe('ghwc pci output; null when ghwc not present.'),
    ghw_product: z.unknown().nullable().describe('ghwc product output; null when ghwc not present.'),
  }),
} as const;

export const ib_data = {
  input: z.object({}),
  output: z.object({
    ib_data: z
      .array(
        z.object({
          mlx5_name: z.string().describe('Mellanox driver-assigned device name (e.g. mlx5_0).'),
          guid: z.string().nullable().describe('Port GUID; null when unreadable.'),
          speed: z
            .string()
            .nullable()
            .describe('Port speed string (e.g. "100 Gb/sec (4X EDR)"). Null when unreadable.'),
          speed_kbps: z.number().int().nonnegative().describe('Parsed speed in kbps; 0 when not extractable.'),
          link_type: z.string().nullable().describe('Link type (IB / Ethernet). Null when unreadable.'),
          port_state: z.string().nullable().describe('Port state string. Null when unreadable.'),
          link_oper_up: z.boolean().describe('True iff the port_state reports ACTIVE.'),
          port_phys_state: z.string().nullable().describe('Physical state string. Null when unreadable.'),
          link_physical_up: z.boolean().describe('True iff the physical state reports LinkUp.'),
          pci_device_id: z.string().nullable().describe('PCI device identifier. Null when unreadable.'),
          max_speed_gbps: z.number().int().nullable().describe('Max speed in Gbps; null when unreadable.'),
          max_speed_kbps: z.number().int().nonnegative().describe('Max speed in kbps.'),
        }),
      )
      .describe('Per-InfiniBand-port records. Empty array when the system has no IB adapters.'),
  }),
} as const;

export const nvidia = {
  input: z.object({}),
  output: z.object({
    nvidia: z
      .union([
        z.object({}).strict().describe('Empty object on no-GPU systems.'),
        z.object({
          count: z.number().int().nonnegative().describe('GPU count.'),
          model: z.string().nullable().describe('Model string when all GPUs share one; null otherwise.'),
          gpus: z
            .array(
              z.object({
                index: z.number().int().nonnegative().describe('GPU index (nvidia-smi order).'),
                name: z.string().describe('GPU product name.'),
                uuid: z.string().describe('GPU UUID.'),
                'temperature.gpu': z
                  .number()
                  .int()
                  .nullable()
                  .describe('GPU temperature in °C; null when unavailable.'),
                'utilization.gpu': z
                  .number()
                  .int()
                  .nullable()
                  .describe('GPU utilisation percent; null when unavailable.'),
                'memory.used': z.number().int().nullable().describe('Used GPU memory in MiB; null when unavailable.'),
                'memory.total': z.number().int().nullable().describe('Total GPU memory in MiB; null when unavailable.'),
                'memory.free': z.number().int().nullable().describe('Free GPU memory in MiB; null when unavailable.'),
                vbios: z.string().optional().describe('vbios_version when available.'),
                serial: z.string().optional().describe('GPU board serial number when available.'),
              }),
            )
            .describe('Per-GPU records.'),
        }),
      ])
      .describe('Either {} on no-GPU systems or a populated GPU summary.'),
  }),
} as const;

export const dmidecode = {
  input: z.object({}),
  output: z.object({
    dmidecode: z.unknown().describe('jc-parsed dmidecode output; opaque to this layer.'),
  }),
} as const;

export const efibootmgr = {
  input: z.object({}),
  output: z.object({
    efibootmgr: z.unknown().describe('jc-parsed efibootmgr output; opaque to this layer.'),
  }),
} as const;

export const memory = {
  input: z.object({}),
  output: z.object({
    dmidecode_memory: z.unknown().describe('jc-parsed `dmidecode -t memory` output; opaque to this layer.'),
  }),
} as const;

export const kernel_params = {
  input: z.object({}),
  output: z.object({
    kernel_params: z.object({
      current_cmdline: z.string().describe('Raw /proc/cmdline content.'),
      parsed_parameters: z
        .object({
          console: z.array(z.string()),
          display: z.array(z.string()),
          security: z.array(z.string()),
          network: z.array(z.string()),
          storage: z.array(z.string()),
          power: z.array(z.string()),
          hardware: z.array(z.string()),
          other: z.array(z.string()),
        })
        .describe('/proc/cmdline params bucketed by functional category.'),
      ubuntu_version: z
        .string()
        .optional()
        .nullable()
        .describe('Ubuntu version string when detectable from /etc/os-release.'),
      grub_config: z
        .object({
          cmdline_linux: z.string().optional().describe('GRUB_CMDLINE_LINUX_DEFAULT value.'),
          terminal: z.string().optional().describe('GRUB_TERMINAL setting.'),
          serial_command: z.string().optional().describe('GRUB_SERIAL_COMMAND setting.'),
        })
        .partial()
        .describe('Relevant keys read from /etc/default/grub.'),
      hardware_analysis: z
        .object({
          gpu_type: z.enum(['nvidia', 'amd', 'none', 'unknown']).describe('Detected GPU vendor.'),
          gpu_compatibility: z
            .enum(['configured', 'needs_nomodeset'])
            .optional()
            .describe('Whether cmdline already has the GPU-compatible args.'),
          cpu_vendor: z.enum(['intel', 'amd', 'unknown']).describe('CPU vendor family.'),
          vtd_support: z.boolean().describe('Intel VT-d support detected in cmdline or CPU flags.'),
          iommu_status: z
            .enum(['enabled', 'disabled_but_supported', 'not_supported', 'unknown'])
            .describe('IOMMU activation state.'),
          system_manufacturer: z.string().describe('dmidecode system manufacturer.'),
        })
        .describe('Derived hardware-context analysis that informs issues/recommendations.'),
      issues_detected: z
        .array(
          z.object({
            severity: z.string().describe('Severity tag, e.g. "high", "medium", "low".'),
            message: z.string().describe('Human-readable description of the issue.'),
          }),
        )
        .describe('Issues matched against current cmdline and hardware.'),
      recommendations: z
        .array(
          z.object({
            action: z.string().describe("What to do, e.g. 'add', 'remove', 'set'."),
            parameter: z.string().describe('Cmdline parameter name the action targets.'),
            reason: z.string().describe('Why this recommendation is issued.'),
          }),
        )
        .describe('Actionable recommendations paired to detected issues.'),
    }),
  }),
} as const;

export const nvidia_detailed = {
  input: z.object({}),
  output: z.object({
    nvidia_detailed: z
      .union([
        z.object({}).strict().describe('Empty object on no-GPU systems.'),
        z.object({
          count: z.number().int().nonnegative().describe('GPU count.'),
          model: z.string().nullable().describe('Shared model string; null when mixed or unavailable.'),
          gpus: z
            .array(z.record(z.string(), z.string()))
            .describe('Per-GPU nvidia-smi CSV rows; Python does not coerce values, so every field stays string.'),
          pcie: z
            .array(
              z.object({
                index: z.number().int().nonnegative().describe('GPU index.'),
                'pcie.link.gen.current': z.string().describe('Current PCIe generation.'),
                'pcie.link.gen.max': z.string().describe('Max supported PCIe generation.'),
              }),
            )
            .describe('Per-GPU PCIe generation.'),
          lspci: z
            .array(
              z.object({
                bus_id: z.string().describe('PCI BDF address.'),
                device: z.string().nullable().optional(),
                link_cap_speed: z.string().nullable().optional(),
                link_cap_width: z.string().nullable().optional(),
                link_sta_speed: z.string().nullable().optional(),
                link_sta_width: z.string().nullable().optional(),
                trans_pending: z.boolean().nullable().optional(),
                error: z.string().optional().describe('lspci parse error text when the row could not be extracted.'),
              }),
            )
            .describe('Per-GPU lspci regex-extracted cap/status speeds and widths.'),
        }),
      ])
      .describe('Either {} or a populated extended GPU summary.'),
  }),
} as const;

export const serial_ports = {
  input: z.object({}),
  output: z.object({
    serial_ports: z.object({
      hardware_platform: z
        .object({
          manufacturer: z.string().nullable().describe('dmidecode system manufacturer; null when unreadable.'),
          model: z.string().nullable().describe('dmidecode product name; null when unreadable.'),
          architecture: z.string().nullable().describe('Architecture string; null when unreadable.'),
        })
        .describe('Platform identity used to select recommendation tables.'),
      detected_ports: z
        .record(
          z.string(),
          z.object({
            hardware_line: z.number().int().describe('Line number reported by /proc/tty/driver/serial.'),
            uart_type: z.string().optional().describe('UART chip family.'),
            hardware_address: z.string().optional().describe('I/O port address.'),
            irq: z.number().int().optional().describe('IRQ number.'),
            hardware_status: z.enum(['active', 'inactive', 'unknown']).optional().describe('Port status from /proc.'),
            base_baud: z.number().int().optional().describe('Base baud rate used to derive compatible baud rates.'),
            physically_accessible: z
              .boolean()
              .optional()
              .describe('Whether the port corresponds to a physical rear-panel connector.'),
          }),
        )
        .describe("Detected serial ports keyed by device name (e.g. 'ttyS0')."),
      bmc_sol_hardware: z
        .object({
          sol_capable: z.boolean().describe('True iff the BMC advertises Serial-over-LAN capability.'),
          sol_enabled: z.boolean().optional().describe('True iff SOL is enabled in the BMC payload config.'),
          hardware_channel: z.number().int().nullable().optional().describe('IPMI channel the BMC exposes for SOL.'),
          hardware_baud_rate: z.number().int().nullable().optional().describe('BMC-configured SOL baud rate.'),
          hardware_port: z.number().int().nullable().optional().describe('BMC-configured SOL port.'),
          encryption_capable: z.boolean().optional().describe('True iff encryption is available on the SOL channel.'),
          authentication_capable: z
            .boolean()
            .optional()
            .describe('True iff authentication is available on the SOL channel.'),
        })
        .passthrough()
        .describe('BMC SOL capability + current configuration.'),
      ports: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe('Per-tty detail for the available (active) serial ports; keys are device names (e.g. "ttyS1").'),
      resolved: z
        .object({
          port: z.string().describe('Resolved console device, e.g. "ttyS1".'),
          baud: z.number().int().describe('Resolved console baud rate.'),
          source: z
            .enum(['probed', 'modem_hint', 'vendor_table', 'none'])
            .describe(
              'How the port was chosen: probed (empirical SOL match), modem_hint (in-band hardware evidence), vendor_table (BMC/vendor convention), none.',
            ),
          confirmed: z
            .boolean()
            .describe(
              'True only when an empirical SOL probe confirmed the mapping; false for in-band/heuristic resolutions.',
            ),
          notes: z.array(z.string()).optional().describe('Human-readable basis for the resolution.'),
        })
        .optional()
        .describe(
          'Best-effort serial console (port+baud) resolved in-band from SOL config + detected ports. Absent when no SOL-capable console could be resolved.',
        ),
    }),
  }),
} as const;

const SecureBootStoreSchema = z
  .object({
    count: z.number().int().nonnegative().describe('Max of fingerprint / subject counts; 0 when store is empty.'),
    sha1_fingerprints: z
      .array(z.string())
      .describe("Hex-lowercase SHA-1 fingerprints (no colons), from mokutil's `SHA1 Fingerprint:` lines."),
    sha256_fingerprints: z
      .array(z.string())
      .describe(
        'Hex-lowercase SHA-256 fingerprints (no colons). Empty when mokutil emits only SHA-1; the handler then derives SHA-256 from any PEM blocks it can decode.',
      ),
    subjects: z.array(z.string()).describe('Subject DNs in the order encountered.'),
    issuers: z.array(z.string()).describe('Issuer DNs in the order encountered.'),
    not_after: z.array(z.string()).describe('Not-After date strings in the order encountered.'),
    raw_excerpt: z.string().describe('Raw stdout from the mokutil store dump, capped at 8 KiB.'),
  })
  .describe('Per-key-store metadata bundle (db / dbx / pk / kek / enrolled_mok / pending_mok).');

export const secure_boot = {
  input: z.object({}),
  output: z.object({
    secure_boot: z
      .object({
        firmware: z.enum(['efi', 'bios']).describe("'efi' iff /sys/firmware/efi exists, else 'bios'."),
        tooling: z
          .enum(['mokutil_present', 'mokutil_absent'])
          .optional()
          .describe('Whether mokutil resolved on PATH; absent on bios short-circuit.'),
        sb_enabled: z
          .boolean()
          .nullable()
          .describe('True / false from mokutil --sb-state or efivar fallback; null when undetermined.'),
        sb_state_raw: z.string().optional().describe('Raw `mokutil --sb-state` output.'),
        sb_version_raw: z.string().optional().describe('Raw `mokutil --sb-version` output (shim version).'),
        setup_mode: z
          .boolean()
          .nullable()
          .optional()
          .describe('SetupMode EFI flag; true when firmware is in factory setup mode.'),
        audit_mode: z.boolean().nullable().optional().describe('AuditMode EFI flag.'),
        enrolled_mok: SecureBootStoreSchema.optional().describe('`mokutil --list-enrolled`.'),
        pending_mok: SecureBootStoreSchema.optional().describe('`mokutil --list-new`.'),
        pk: SecureBootStoreSchema.optional().describe('Platform Key store — `mokutil --pk`.'),
        kek: SecureBootStoreSchema.optional().describe('Key Exchange Key store — `mokutil --kek`.'),
        db: SecureBootStoreSchema.optional().describe('Allowed signatures db — `mokutil --db`.'),
        dbx: SecureBootStoreSchema.optional().describe('Forbidden signatures dbx — `mokutil --dbx`.'),
        revoked_raw: z.string().optional().describe('Raw `mokutil --list-revoked` output, capped at 8 KiB.'),
      })
      .describe(
        'Per-chassis Secure Boot + MOK + firmware-key-database snapshot. Bios firmware short-circuits to just { firmware: "bios", sb_enabled: null }.',
      ),
  }),
} as const;

export const operations = {
  collectAll,
  architecture,
  version,
  efi,
  ip,
  is_virtual,
  lshw,
  lstopo,
  lldp,
  bdi,
  lsblk,
  lscpu,
  public_ip,
  route,
  virtualization,
  bmc,
  ghw,
  ib_data,
  nvidia,
  dmidecode,
  efibootmgr,
  memory,
  kernel_params,
  nvidia_detailed,
  serial_ports,
  secure_boot,
} as const;
