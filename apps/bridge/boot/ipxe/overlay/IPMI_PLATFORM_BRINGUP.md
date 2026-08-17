# IPMI Platform Bring-Up Diagnostics

This doc captures the diagnostic methodology and ready-to-paste code snippets
used during the NVIDIA Grace ARM64 bring-up that added
`core/ipmi_efi_i2cio.c`. Keep it for the next time `${ipmi/*}` shows up empty
on a new platform.

The diagnostics are deliberately not in the live source tree (they printed
on every boot and were noisy). When you need them again, paste the snippets
below into a temporary `.c` file under `core/` (or back into
`core/ipmi_efi_transport.c`), wire the entry points into `ipmi_init()`,
build, deploy, and observe the iPXE console output. Remove again once the
new platform's permanent backend is selected.

## When this doc applies

- A new ARM64 platform shows up with empty `${ipmi/ip}`, `${ipmi/mac}`,
  `${ipmi/tag}` during commissioning.
- A new x86 platform whose BMC isn't on KCS stops working.
- You are adding a vendor whose BMC sits behind a UEFI protocol the current
  three backends don't target.

## Existing transports (try in this order)

`ipmi_init()` attempts the two production transports in this order on
SSIF-reporting hardware:

1. **`efi_i2cio_intf`** — `core/ipmi_efi_i2cio.c`. Walks I2cIo handles,
   matches `DeviceGuid` against `known_bmc_guids[]`, speaks SSIF directly
   to the matched handle. Verified on NVIDIA Grace via `gNVIDIAI2cBmcSSIF`.
2. **`ssif_intf`** — `core/ipmi_ssif.c` over
   `interface/efi/efi_smbus.c`. `LocateProtocol` on
   `EFI_SMBUS_HC_PROTOCOL`. Legacy; almost never published in modern
   firmware.

> A third backend targeting `gIpmiTransportProtocolGuid` (EDK2
> IpmiFeaturePkg) was prototyped during the Grace bring-up but was
> removed before merge because the only hardware available at the time
> (NVIDIA Grace AMI Aptio) did not preserve the protocol into BDS,
> leaving the `IpmiSubmitCommand` code path completely unverified. The
> protocol survey snippet below still includes the IpmiTransport GUID;
> if a future platform publishes it, re-implement the backend (~100
> LOC) and add it as a first-try transport.

If a new platform isn't bound by any of these, run the diagnostics below
to figure out which UEFI protocols its firmware _does_ publish, then
either add a new BMC GUID to `known_bmc_guids[]` (cheapest) or write a
new backend targeting a different protocol.

## Diagnostic methodology

1. **Confirm the symptom from Linux.** SSH the target, run `ipmitool lan
print -vvvv` and check `dmesg | grep -i ipmi`. If `ipmitool` works
   from the OS, the BMC is reachable; the problem is iPXE-side. If
   `dmesg` says `ipmi_si: Unable to find any System Interface(s)` and
   `ipmi_ssif: Found new BMC`, the BMC is on I2C/SSIF (no KCS).
2. **Inspect SMBIOS Type 38 and ACPI tables.** `dmidecode -t 38` should
   report `Interface Type: SSIF`, an I2C slave address, and a base
   address. Mismatch with what iPXE detects points at the SMBIOS parser.
3. **Survey published UEFI protocols** (snippet 1 below). Tells you
   whether the platform exposes `IpmiTransport`, `Ipmi`, `SmbusHc`,
   `I2cMaster`, `I2cHost`, `I2cIo`, or `I2cEnumerate` at boot
   application phase.
4. **For I2cIo-capable firmware, walk handles** (snippet 2). Each I2cIo
   handle carries a `DeviceGuid`; one of them should match a known BMC
   GUID. If none match, scan the printed GUIDs — there may be a vendor
   GUID you can add to `known_bmc_guids[]`.
5. **One-shot SSIF Get Device ID** (snippet 3) against the matched
   handle. Compare the response bytes to `ipmitool raw 0x6 0x1` on the
   same BMC. Match means the wire protocol works and the production
   backend will too.

## Snippet 1 — Survey published UEFI BMC-transport protocols

Pastes back into a `.c` file in `core/`. Declare
`extern void efi_ipmi_probe_handles ( void );` in `include/ipxe/ipmi.h`
and call from `ipmi_init()` (top, before existing logic).

```c
/** Candidate UEFI protocols that could mediate BMC access. */
static const struct {
	const char *name;
	EFI_GUID guid;
} efi_ipmi_probe_table[] = {
	{ "SmbusHc",
	  { 0xe49d33ed, 0x513d, 0x4634,
	    { 0xb6, 0x98, 0x6f, 0x55, 0xaa, 0x75, 0x1c, 0x1b } } },
	{ "I2cMaster",
	  { 0xcd72881f, 0x45b5, 0x4feb,
	    { 0x98, 0xc8, 0x31, 0x3d, 0xa8, 0x11, 0x74, 0x62 } } },
	{ "I2cHost",
	  { 0xa5aab9e3, 0xc727, 0x48cd,
	    { 0x8b, 0xbf, 0x42, 0x72, 0x33, 0x85, 0x49, 0x48 } } },
	{ "I2cIo",
	  { 0xb60a3e6b, 0x18c4, 0x46e5,
	    { 0xa2, 0x9a, 0xc9, 0xa1, 0x06, 0x65, 0xa2, 0x8e } } },
	{ "I2cEnumerate",
	  { 0xda8cd7c4, 0x1c00, 0x49e2,
	    { 0x80, 0x3e, 0x52, 0x14, 0xe7, 0x01, 0x89, 0x4c } } },
	{ "IpmiTransport",
	  { 0x6bb945e8, 0x3743, 0x433e,
	    { 0xb9, 0x0e, 0x29, 0xb3, 0x0d, 0x5d, 0xc6, 0x30 } } },
	{ "Ipmi",
	  { 0xdbc6381f, 0x5554, 0x4d14,
	    { 0x8f, 0xfd, 0x76, 0xd7, 0x87, 0xb8, 0xac, 0xbf } } },
};

void efi_ipmi_probe_handles ( void ) {
	EFI_BOOT_SERVICES *bs = efi_systab->BootServices;
	unsigned int i;

	printf ( "EFI PROBE: scanning candidate BMC-transport protocols\n" );
	for ( i = 0; i < ( sizeof ( efi_ipmi_probe_table ) /
			   sizeof ( efi_ipmi_probe_table[0] ) ); i++ ) {
		UINTN count = 0;
		EFI_HANDLE *handles = NULL;
		EFI_STATUS efirc;

		efirc = bs->LocateHandleBuffer ( ByProtocol,
						 ( EFI_GUID * )
						 &efi_ipmi_probe_table[i].guid,
						 NULL, &count, &handles );
		if ( efirc == 0 ) {
			printf ( "EFI PROBE:   %s = %d handle(s)\n",
				 efi_ipmi_probe_table[i].name,
				 ( int ) count );
			bs->FreePool ( handles );
		} else {
			printf ( "EFI PROBE:   %s = not found\n",
				 efi_ipmi_probe_table[i].name );
		}
	}
}
```

Expected output on NVIDIA Grace / Quanta S74G-2U:

```
EFI PROBE: scanning candidate BMC-transport protocols
EFI PROBE:   SmbusHc = not found
EFI PROBE:   I2cMaster = 3 handle(s)
EFI PROBE:   I2cHost = 3 handle(s)
EFI PROBE:   I2cIo = 4 handle(s)
EFI PROBE:   I2cEnumerate = 3 handle(s)
EFI PROBE:   IpmiTransport = not found
EFI PROBE:   Ipmi = not found
```

Interpreting the output:

- **`SmbusHc = not found`**: the legacy `ssif_intf` cannot work; skip it.
- **`I2cMaster/I2cHost/I2cIo/I2cEnumerate` present**: the platform exposes
  the PI I2C stack. `I2cIo` is the preferred target (per-device handles
  carrying a `DeviceGuid`).
- **`IpmiTransport = not found`**: even though NVIDIA's edk2-nvidia
  installs `gIpmiTransportProtocolGuid` via
  `I2cIoBmcSsifDxe`, AMI's Aptio build for Quanta does not preserve it
  into BDS. `efi_ipmi_intf` therefore fails on this hardware.

## Snippet 2 — Walk I2cIo handles, identify BMC by DeviceGuid

```c
/** EFI_I2C_OPERATION (PI Vol 5). Flags bit 0 = READ; otherwise WRITE. */
typedef struct {
	UINT32 Flags;
	UINT32 LengthInBytes;
	UINT8 *Buffer;
} efi_ipmi_i2c_op_t;

#define EFI_IPMI_I2C_FLAG_READ 0x00000001

/** EFI_I2C_REQUEST_PACKET (PI Vol 5). Variable-length tail. */
typedef struct {
	UINTN OperationCount;
	efi_ipmi_i2c_op_t Operation[3];
} efi_ipmi_i2c_packet_t;

struct efi_ipmi_i2cio_diag;

/** EFI_I2C_IO_PROTOCOL.QueueRequest signature (sync when Event==NULL). */
typedef EFI_STATUS ( EFIAPI *efi_ipmi_queue_req_t ) (
	const struct efi_ipmi_i2cio_diag *This,
	UINTN SlaveAddressIndex,
	VOID *Event,
	VOID *RequestPacket,
	EFI_STATUS *I2cStatus
);

/** Layout-compatible mirror of EDK2's EFI_I2C_IO_PROTOCOL. */
typedef struct efi_ipmi_i2cio_diag {
	efi_ipmi_queue_req_t QueueRequest;
	const EFI_GUID *DeviceGuid;
	UINT32 DeviceIndex;
	UINT32 HardwareRevision;
	const VOID *I2cControllerCapabilities;
} efi_ipmi_i2cio_diag_t;

/** EFI I2C IO Protocol GUID. */
static EFI_GUID efi_i2cio_guid = {
	0xb60a3e6b, 0x18c4, 0x46e5,
	{ 0xa2, 0x9a, 0xc9, 0xa1, 0x06, 0x65, 0xa2, 0x8e }
};

/** NVIDIA gNVIDIAI2cBmcSSIF. */
static const EFI_GUID nvidia_bmc_ssif_guid = {
	0xb4fcca9e, 0x93ec, 0x4fb5,
	{ 0x87, 0x81, 0x54, 0x07, 0x0c, 0x54, 0x39, 0x06 }
};

void efi_ipmi_walk_i2cio_devices ( void ) {
	EFI_BOOT_SERVICES *bs = efi_systab->BootServices;
	UINTN count = 0;
	EFI_HANDLE *handles = NULL;
	EFI_STATUS efirc;
	unsigned int i;

	efirc = bs->LocateHandleBuffer ( ByProtocol, &efi_i2cio_guid,
					 NULL, &count, &handles );
	if ( efirc != 0 ) {
		printf ( "I2cIo WALK: LocateHandleBuffer failed\n" );
		return;
	}

	printf ( "I2cIo WALK: %d device handle(s)\n", ( int ) count );
	for ( i = 0; i < count; i++ ) {
		efi_ipmi_i2cio_diag_t *io = NULL;
		const char *role = "";

		efirc = bs->HandleProtocol ( handles[i], &efi_i2cio_guid,
					     ( void ** ) &io );
		if ( efirc != 0 || io == NULL || io->DeviceGuid == NULL ) {
			printf ( "  handle[%d]: HandleProtocol failed\n", i );
			continue;
		}

		int is_bmc = ( memcmp ( io->DeviceGuid,
					&nvidia_bmc_ssif_guid,
					sizeof ( EFI_GUID ) ) == 0 );
		if ( is_bmc )
			role = "  <-- NVIDIA BMC SSIF";

		printf ( "  handle[%d]: DeviceGuid="
			 "%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x"
			 " DevIdx=%d%s\n",
			 i,
			 ( int ) io->DeviceGuid->Data1,
			 ( int ) io->DeviceGuid->Data2,
			 ( int ) io->DeviceGuid->Data3,
			 io->DeviceGuid->Data4[0],
			 io->DeviceGuid->Data4[1],
			 io->DeviceGuid->Data4[2],
			 io->DeviceGuid->Data4[3],
			 io->DeviceGuid->Data4[4],
			 io->DeviceGuid->Data4[5],
			 io->DeviceGuid->Data4[6],
			 io->DeviceGuid->Data4[7],
			 ( int ) io->DeviceIndex,
			 role );

		if ( is_bmc )
			efi_ipmi_probe_get_device_id ( io );
	}

	bs->FreePool ( handles );
}
```

Expected output on NVIDIA Grace / Quanta S74G-2U:

```
I2cIo WALK: 4 device handle(s)
  handle[0]: DeviceGuid=26deb510-143c-11ed-8018-83267fa328b3 DevIdx=0
  handle[1]: DeviceGuid=e7da2b8d-25bd-4e6f-acfc-3b62187073bd DevIdx=0
  handle[2]: DeviceGuid=b4fcca9e-93ec-4fb5-8781-54070c543906 DevIdx=0  <-- NVIDIA BMC SSIF
  handle[3]: DeviceGuid=d51998dc-df15-453c-b7c3-a5b2fa61fe73 DevIdx=0
```

For a new vendor, scan the printed GUIDs against the vendor's published
edk2 (or platform DSC/INF files). Add the BMC GUID to
`known_bmc_guids[]` in `core/ipmi_efi_i2cio.c` to enable the production
backend.

## Snippet 3 — One-shot SSIF Get Device ID

```c
static void efi_ipmi_probe_get_device_id ( efi_ipmi_i2cio_diag_t *io ) {
	/* Write: [SSIF cmd=0x02, len=2, NetFn|LUN=0x18, Cmd=0x01] */
	static UINT8 write_buf[] = { 0x02, 0x02, 0x18, 0x01 };
	/* Read setup: [SSIF cmd=0x03] then read [len, payload...] */
	static UINT8 read_cmd = 0x03;
	UINT8 read_buf[33] = { 0 };
	efi_ipmi_i2c_packet_t write_pkt = {
		.OperationCount = 1,
		.Operation[0] = { .Flags = 0,
				  .LengthInBytes = sizeof ( write_buf ),
				  .Buffer = write_buf },
	};
	efi_ipmi_i2c_packet_t read_pkt = {
		.OperationCount = 2,
		.Operation[0] = { .Flags = 0,
				  .LengthInBytes = sizeof ( read_cmd ),
				  .Buffer = &read_cmd },
		.Operation[1] = { .Flags = EFI_IPMI_I2C_FLAG_READ,
				  .LengthInBytes = sizeof ( read_buf ),
				  .Buffer = read_buf },
	};
	EFI_STATUS efirc;
	unsigned int i;

	printf ( "I2cIo PROBE: sending Get Device ID to BMC handle\n" );
	efirc = io->QueueRequest ( io, 0, NULL, &write_pkt, NULL );
	if ( efirc != 0 ) {
		printf ( "I2cIo PROBE: write QueueRequest failed"
			 " efirc=%lx\n", ( unsigned long ) efirc );
		return;
	}

	/* SSIF requires the host to poll for the response — the BMC needs
	 * time between accepting the request and being ready to serve the
	 * read. NACKs surface as EFI_NO_RESPONSE; retry with 10ms backoff
	 * up to ~500ms total, matching FreeIPMI ssif-driver behaviour. */
	for ( i = 0; i < 50; i++ ) {
		mdelay ( 10 );
		efirc = io->QueueRequest ( io, 0, NULL, &read_pkt, NULL );
		if ( efirc == 0 ) {
			printf ( "I2cIo PROBE: read succeeded on attempt %d"
				 " (~%dms wait)\n", ( int )( i + 1 ),
				 ( int )( ( i + 1 ) * 10 ) );
			break;
		}
	}
	if ( efirc != 0 ) {
		printf ( "I2cIo PROBE: read QueueRequest failed after 50"
			 " attempts efirc=%lx\n", ( unsigned long ) efirc );
		return;
	}

	printf ( "I2cIo PROBE: response (first 17 bytes):" );
	for ( i = 0; i < 17; i++ )
		printf ( " %02x", read_buf[i] );
	printf ( "\n" );
}
```

Expected response on NVIDIA Grace / Quanta S74G-2U:

```
I2cIo PROBE: read succeeded on attempt 1 (~10ms wait)
I2cIo PROBE: response (first 17 bytes): 12 1c 01 00 20 81 03 09 02 bf 4c 1c 00 47 37 00 03
```

Decoded:

| Offset | Byte          | Meaning                                         |
| ------ | ------------- | ----------------------------------------------- |
| 0      | `12`          | SSIF length = 18 bytes follow                   |
| 1      | `1c`          | NetFn echo (`0x07 << 2` = App Response)         |
| 2      | `01`          | Cmd echo (Get Device ID)                        |
| 3      | `00`          | Completion Code = SUCCESS                       |
| 4      | `20`          | Device ID                                       |
| 5      | `81`          | Device Revision + provides-SDRs flag            |
| 6      | `03`          | FW Rev major                                    |
| 7      | `09`          | FW Rev minor (BCD)                              |
| 8      | `02`          | IPMI v2.0                                       |
| 9      | `bf`          | Additional Device Support bitmask               |
| 10-12  | `4c 1c 00`    | Manufacturer ID LSB-first = `0x001c4c` = NVIDIA |
| 13-14  | `47 37`       | Product ID LSB-first = `0x3747`                 |
| 15-18  | `00 03 15 00` | Auxiliary FW Rev                                |

Compare against `ipmitool raw 0x6 0x1` run on the same BMC from Linux on
the target. The IPMI payload bytes (offsets 4 onward) should match
exactly. The leading SSIF length / NetFn echo / Cmd echo / CC bytes are
SSIF wire framing and only appear here.

## Wiring the diagnostics into `ipmi_init()`

Add forward declarations in `include/ipxe/ipmi.h`:

```c
extern void efi_ipmi_probe_handles ( void );
extern void efi_ipmi_walk_i2cio_devices ( void );
```

Call from `core/ipmi.c::ipmi_init()` at the very top (after the
`if ( current_intf ) return 0;` guard):

```c
efi_ipmi_probe_handles();
efi_ipmi_walk_i2cio_devices();
```

If the new file containing the snippets isn't `core/ipmi_efi_transport.c`
or similar already pulled in by `REQUIRE_OBJECT`, add it to
`config/config.c`:

```c
REQUIRE_OBJECT ( <new_filename_without_extension> );
```

…and claim an `ERRFILE_*` ID in `include/ipxe/errfile.h` (next available
in the `ERRFILE_CORE` block).

## NVIDIA Grace bring-up summary (May 2026)

**Hardware**: Quanta QuantaGrid S74G-2U (NVIDIA Grace ARM64).

**Firmware**: AMI Aptio built on top of NVIDIA's edk2-nvidia.

**Symptoms before fix**:

- `dmesg`: `ipmi_si: Unable to find any System Interface(s)` (no KCS).
- `dmesg`: `ipmi_ssif: Found new BMC (man_id: 0x001c4c)` (BMC on I2C/SSIF).
- iPXE `${ipmi/*}` empty.
- `ipmitool lan print` from the running OS worked (BMC functional).

**Root cause**:

- BMC sits on Tegra I2C bus 3 at slave `0x10` per SMBIOS Type 38.
- ARM has no x86 port I/O, so KCS is impossible.
- AMI Aptio's build for Quanta doesn't preserve
  `gIpmiTransportProtocolGuid` into BDS even though
  `I2cIoBmcSsifDxe` installs it during DXE.
- `EFI_SMBUS_HC_PROTOCOL` is not published either (rare in modern
  firmware).
- `EFI_I2C_IO_PROTOCOL` _is_ published, with the BMC's handle tagged
  `gNVIDIAI2cBmcSSIF` = `b4fcca9e-93ec-4fb5-8781-54070c543906`.

**Fix**: `core/ipmi_efi_i2cio.c` — bind to the BMC's `I2cIo` handle by
matching DeviceGuid against `known_bmc_guids[]`, then speak SSIF
directly: SMBus block write (cmd `0x02`) for IPMI requests, SMBus block
read (cmd `0x03`) for responses, poll with 10ms backoff between the two
because the BMC needs processing time. Single-part SSIF only (covers
every IPMI command iPXE issues; multi-part is >32 byte blocks which
nothing here needs).

**Adding new NVIDIA-based platforms**: typically no code change. The
same `gNVIDIAI2cBmcSSIF` DeviceGuid is assigned by `TegraI2cDxe` for any
device-tree node with `compatible = "ssif-bmc"`.

**Adding non-NVIDIA ARM platforms**: run snippets 1+2 to find the BMC's
DeviceGuid, then append it to `known_bmc_guids[]` in
`core/ipmi_efi_i2cio.c`.

## References

- IPMI 2.0 SSIF spec — Intel. SMBus block write/read with command bytes
  `0x02/0x03` (single-part) or `0x06/0x07/0x08/0x09` (multi-part).
- EDK2 PI Spec Vol 5 — `EFI_I2C_IO_PROTOCOL`,
  `EFI_I2C_OPERATION`, `EFI_I2C_REQUEST_PACKET` definitions.
- NVIDIA edk2-nvidia: https://github.com/NVIDIA/edk2-nvidia
  - `Silicon/NVIDIA/Drivers/TegraI2c/TegraI2cDxe.c` — produces
    `I2cMaster` + `I2cEnumerate`, tags BMC node with
    `gNVIDIAI2cBmcSSIF`.
  - `Silicon/NVIDIA/Drivers/I2cIoBmcSsifDxe/` — consumes those,
    _would_ produce `IpmiTransport` if its DXE driver ran and the
    protocol survived into BDS.
  - `Silicon/NVIDIA/NVIDIA.dec:70` — `gNVIDIAI2cBmcSSIF` GUID definition.
- iPXE upstream: https://github.com/ipxe/ipxe
- FreeIPMI: reference for SSIF retry/backoff timing
  (https://www.gnu.org/software/freeipmi/ — `libfreeipmi/driver/ipmi-ssif-driver.c`).
- ipmitool: reference IPMI command framing
  (https://github.com/ipmitool/ipmitool).
