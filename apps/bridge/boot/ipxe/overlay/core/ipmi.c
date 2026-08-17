/*
 * Copyright (C) 2024 iPXE Contributors
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation; either version 2 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA
 * 02110-1301, USA.
 */

FILE_LICENCE ( GPL2_OR_LATER_OR_UBDL );

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <ipxe/io.h>
#include <ipxe/ipmi.h>
#include <ipxe/errfile.h>
#include <ipxe/smbios.h>
#include <ipxe/acpi.h>

/** @file
 *
 * Intelligent Platform Management Interface (IPMI)
 *
 */



static struct ipmi_intf *current_intf = NULL;

/* KCS is CPU port-I/O (inb/outb), which only exists on x86.  On AArch64
 * inb() resolves to a raw MMIO read of the port address, so reaching the
 * KCS probe would fault (data abort) rather than returning 0xFF.  Gate the
 * attempt so non-x86 boards whose SSIF transports (efi_i2cio/ssif) don't
 * bind fall through cleanly to -ENODEV; the autoexec's
 * `ipmi lan || goto start` then continues to boot.
 *
 * NB: this gate is distinct from the efi_path.c IPv6-reloc fix in the same
 * overlay.  Both are needed and neither subsumes the other: efi_path faulted
 * during device init (before the autoexec), KCS would fault later at
 * `ipmi lan`.  Do not remove this guard assuming the efi_path fix alone
 * suffices.  Kept as a compile-time constant in an if() rather than an #ifdef
 * around the call so kcs_intf stays referenced and compiles under -Werror on
 * every arch; the compiler drops the dead `0 && ...` branch. */
#if defined ( __i386__ ) || defined ( __x86_64__ )
#define IPMI_HAVE_PORT_IO 1
#else
#define IPMI_HAVE_PORT_IO 0
#endif

/** KCS base address (will be detected) */
unsigned int ipmi_kcs_base = 0;

/** KCS register spacing (1=byte, 4=dword, 16=16-byte; default 1) */
unsigned int ipmi_kcs_spacing = 1;

/** Flag to indicate if KCS has been detected */
static int kcs_detected = 0;

/** KCS poll timeout (iterations of 1 µs each). Matches FreeIPMI's
 *  IPMI_KCS_TIMEOUT_USECS = 60000000 — the IPMI spec allows BMCs up to
 *  several seconds per operation under load, and the previous 100ms
 *  value caused intermittent timeouts on slow/loaded BMCs. */
#define KCS_POLL_TIMEOUT_USECS		60000000

/**
 * Wait for KCS interface ready
 *
 * @ret rc	Return status code
 */
static int kcs_wait_ibf_clear(void) {
	int timeout = KCS_POLL_TIMEOUT_USECS;
	uint8_t status;

	while (timeout-- > 0) {
		status = inb(IPMI_KCS_STATUS);
		if (!(status & IPMI_KCS_IBF))
			return 0;
		udelay(1);
	}
	return -ETIMEDOUT;
}

/**
 * Wait for KCS output buffer full
 *
 * @ret rc	Return status code
 */
static int kcs_wait_obf_set(void) {
	int timeout = KCS_POLL_TIMEOUT_USECS;
	uint8_t status;

	while (timeout-- > 0) {
		status = inb(IPMI_KCS_STATUS);
		if (status & IPMI_KCS_OBF)
			return 0;
		udelay(1);
	}
	return -ETIMEDOUT;
}

/**
 * Get KCS state
 *
 * @ret state	KCS state
 */
static uint8_t kcs_get_state(void) {
	return inb(IPMI_KCS_STATUS) & IPMI_KCS_STATE_MASK;
}

/**
 * Send command via KCS
 *
 * @v req	IPMI request
 * @v rsp	IPMI response
 * @ret rc	Return status code
 */
static int kcs_send_request(struct ipmi_req *req, struct ipmi_rs *rsp) {
	uint8_t data;
	int i, rc;
	uint8_t write_data[3 + 256]; /* NetFn/LUN + Cmd + data */
	int write_len = 0;

	/* Build write buffer */
	write_data[write_len++] = req->netfn << 2; /* NetFn/LUN */
	write_data[write_len++] = req->cmd;
	for (i = 0; i < req->data_len; i++) {
		write_data[write_len++] = req->data[i];
	}

	/* Clear any pending data */
	if (inb(IPMI_KCS_STATUS) & IPMI_KCS_OBF) {
		data = inb(IPMI_KCS_DATA_IN); /* Clear OBF */
	}

	/* Wait for interface to be ready */
	if ((rc = kcs_wait_ibf_clear()) != 0)
		return rc;

	/* Clear OBF before starting write (critical for proper state machine) */
	if (inb(IPMI_KCS_STATUS) & IPMI_KCS_OBF) {
		data = inb(IPMI_KCS_DATA_IN);
	}

	/* Start write sequence */
	outb(IPMI_KCS_WRITE_START, IPMI_KCS_CMD);
	
	if ((rc = kcs_wait_ibf_clear()) != 0)
		return rc;
	if (kcs_get_state() != IPMI_KCS_WRITE_STATE)
		return -EIO;

	/* Clear OBF again after WRITE_START */
	if (inb(IPMI_KCS_STATUS) & IPMI_KCS_OBF) {
		data = inb(IPMI_KCS_DATA_IN);
	}

	/* Write all but last byte */
	for (i = 0; i < write_len - 1; i++) {
		outb(write_data[i], IPMI_KCS_DATA_OUT);
		
		if ((rc = kcs_wait_ibf_clear()) != 0)
			return rc;
		if (kcs_get_state() != IPMI_KCS_WRITE_STATE)
			return -EIO;
			
		/* Clear OBF if set */
		if (inb(IPMI_KCS_STATUS) & IPMI_KCS_OBF) {
			data = inb(IPMI_KCS_DATA_IN);
		}
	}
	
	/* Send write end */
	outb(IPMI_KCS_WRITE_END, IPMI_KCS_CMD);
	
	if ((rc = kcs_wait_ibf_clear()) != 0)
		return rc;
	if (kcs_get_state() != IPMI_KCS_WRITE_STATE)
		return -EIO;
		
	/* Clear OBF if set */
	if (inb(IPMI_KCS_STATUS) & IPMI_KCS_OBF) {
		data = inb(IPMI_KCS_DATA_IN);
	}
	
	/* Write last byte */
	outb(write_data[write_len - 1], IPMI_KCS_DATA_OUT);

	/* Wait for read state */
	if ((rc = kcs_wait_ibf_clear()) != 0)
		return rc;
	if (kcs_get_state() != IPMI_KCS_READ_STATE)
		return -EIO;

	/* Read response bytes */
	rsp->data_len = 0;
	i = 0;
	while (kcs_get_state() == IPMI_KCS_READ_STATE) {
		if ((rc = kcs_wait_obf_set()) != 0)
			return rc;
		data = inb(IPMI_KCS_DATA_IN);
		
		/* First byte is NetFn/LUN */
		if (i == 0) {
			/* Skip NetFn/LUN */
		}
		/* Second byte is command */
		else if (i == 1) {
			/* Skip command echo */
		}
		/* Third byte is completion code */
		else if (i == 2) {
			rsp->ccode = data;
		}
		/* Rest are response data */
		else if (rsp->data_len < sizeof(rsp->data)) {
			rsp->data[rsp->data_len++] = data;
		}
		
		i++;
		
		/* Send READ command to get next byte (to DATA register like FreeIPMI) */
		outb(IPMI_KCS_READ, IPMI_KCS_DATA_OUT);
		if ((rc = kcs_wait_ibf_clear()) != 0)
			return rc;
	}
	
	/* We should be in IDLE state now */
	if (kcs_get_state() == IPMI_KCS_IDLE_STATE) {
		/* Read and discard the final dummy byte */
		if ((rc = kcs_wait_obf_set()) != 0)
			return rc;
		data = inb(IPMI_KCS_DATA_IN);
	}

	return 0;
}

/**
 * Test if KCS interface is available at given port
 *
 * @v port	KCS port to test
 * @ret rc	Return status code (0 = available)
 */
static int kcs_detect_port(unsigned int port) {
	uint8_t status;
	uint8_t data __unused;

	ipmi_kcs_base = port;

	/* Read status once. 0xFF = floating bus (no hardware). Any other
	 * value — including 0x00, which is the valid IDLE state — means a
	 * device is present; let kcs_verify() confirm it's a real BMC by
	 * sending Get Device ID. This matches FreeIPMI/ipmi_si behavior,
	 * which never rejects a port on the status byte alone. */
	status = inb(IPMI_KCS_STATUS);
	if (status == 0xFF)
		return -ENODEV;

	/* If in READ state from previous command, clean it up */
	if ((status & IPMI_KCS_STATE_MASK) == IPMI_KCS_READ_STATE) {
		/* Send dummy READ commands until we reach IDLE state */
		int timeout = 100;
		while (timeout-- > 0 && (status & IPMI_KCS_STATE_MASK) == IPMI_KCS_READ_STATE) {
			/* Clear OBF if set */
			if (status & IPMI_KCS_OBF) {
				data = inb(IPMI_KCS_DATA_IN);
			}
			/* Send READ to get next byte */
			outb(IPMI_KCS_READ, IPMI_KCS_DATA_OUT);  /* Note: FreeIPMI sends READ to DATA register */
			udelay(100);
			status = inb(IPMI_KCS_STATUS);
		}
		/* Now check if we reached IDLE state */
		if ((status & IPMI_KCS_STATE_MASK) == IPMI_KCS_IDLE_STATE) {
			/* Final dummy read to clear last byte */
			if (status & IPMI_KCS_OBF) {
				data = inb(IPMI_KCS_DATA_IN);
			}
			return 0;
		}
	}
	
	/* Check for valid state bits */
	if ((status & IPMI_KCS_STATE_MASK) == IPMI_KCS_IDLE_STATE ||
	    (status & IPMI_KCS_STATE_MASK) == IPMI_KCS_WRITE_STATE) {
		/* Looks like valid KCS interface */
		return 0;
	}
	
	/* If in error state, try to clear it */
	if ((status & IPMI_KCS_STATE_MASK) == IPMI_KCS_ERROR_STATE) {
		outb(IPMI_KCS_ABORT, IPMI_KCS_CMD);
		udelay(100);
		status = inb(IPMI_KCS_STATUS);
		
		/* Check if error cleared */
		if ((status & IPMI_KCS_STATE_MASK) != IPMI_KCS_ERROR_STATE)
			return 0;
	}
		
	return -ENODEV;
}

/** SMBIOS Type 38 — IPMI Device Information */
#define SMBIOS_TYPE_IPMI_DEVICE_INFO	38

/** SMBIOS IPMI interface types */
#define SMBIOS_IPMI_INTF_KCS		0x01
#define SMBIOS_IPMI_INTF_SMIC		0x02
#define SMBIOS_IPMI_INTF_BT		0x03

/** SMBIOS IPMI Device Information structure (Type 38) */
struct smbios_ipmi_device {
	struct smbios_header header;
	uint8_t interface_type;
	uint8_t ipmi_spec_revision;
	uint8_t i2c_slave_address;
	uint8_t nv_storage_device_address;
	uint64_t base_address;
	uint8_t base_address_modifier;
	uint8_t interrupt_number;
} __attribute__ (( packed ));

/**
 * Try to detect KCS base address from SMBIOS Type 38
 *
 * @ret rc	0 if found, negative error otherwise
 */
static int kcs_detect_smbios(void) {
	const struct smbios_ipmi_device *ipmi_dev;

	ipmi_dev = ( const struct smbios_ipmi_device * )
		smbios_structure ( SMBIOS_TYPE_IPMI_DEVICE_INFO, 0 );
	if ( !ipmi_dev ) {
		DBGC ( &ipmi_kcs_base, "IPMI: No SMBIOS Type 38 record found\n" );
		return -ENODEV;
	}

	/* Only handle KCS interface type */
	if ( ipmi_dev->interface_type != SMBIOS_IPMI_INTF_KCS ) {
		DBGC ( &ipmi_kcs_base, "IPMI: SMBIOS Type 38 interface type %d "
		       "is not KCS\n", ipmi_dev->interface_type );
		return -ENOTSUP;
	}

	/* Extract base address — bit 0 indicates I/O (1) vs memory-mapped (0) */
	uint64_t raw_addr = ipmi_dev->base_address;
	int is_io = raw_addr & 1;
	uint16_t port;

	if ( !is_io ) {
		DBGC ( &ipmi_kcs_base, "IPMI: SMBIOS Type 38 reports memory-mapped "
		       "address (not supported), skipping\n" );
		return -ENOTSUP;
	}

	/* Clear bit 0 (I/O flag) and replace with LS-bit from modifier.
	 * This matches FreeIPMI's ipmi-locate-smbios.c parsing. */
	port = ( uint16_t )( raw_addr & ~1ULL );
	if ( ipmi_dev->base_address_modifier & 0x10 )
		port |= 1;

	if ( port == 0 ) {
		DBGC ( &ipmi_kcs_base, "IPMI: SMBIOS Type 38 reports zero address\n" );
		return -ENODEV;
	}

	/* Extract register spacing from modifier byte bits 7:6 */
	uint8_t spacing_code = ( ipmi_dev->base_address_modifier >> 6 ) & 0x3;
	switch ( spacing_code ) {
	case 0x00: ipmi_kcs_spacing = 1;  break;
	case 0x01: ipmi_kcs_spacing = 4;  break;
	case 0x02: ipmi_kcs_spacing = 16; break;
	default:   ipmi_kcs_spacing = 1;  break;
	}

	DBGC ( &ipmi_kcs_base, "IPMI: SMBIOS Type 38 reports KCS at I/O port "
	       "0x%X (spacing=%d)\n", port, ipmi_kcs_spacing );

	ipmi_kcs_base = port;
	return 0;
}

/** ACPI SPMI table signature */
#define ACPI_SPMI_SIGNATURE	ACPI_SIGNATURE ( 'S', 'P', 'M', 'I' )

/** ACPI GAS address space IDs */
#define ACPI_GAS_SYSTEM_MEMORY	0x00
#define ACPI_GAS_SYSTEM_IO	0x01
#define ACPI_GAS_SMBUS		0x04

/** ACPI SPMI table (after standard 36-byte ACPI header) */
struct acpi_spmi {
	struct acpi_header header;
	uint8_t interface_type;
	uint8_t reserved1;
	uint16_t spec_revision;
	uint8_t interrupt_type;
	uint8_t gpe_number;
	uint8_t reserved2;
	uint8_t pci_device_flag;
	uint32_t global_system_interrupt;
	/* Generic Address Structure (GAS) */
	uint8_t gas_address_space_id;
	uint8_t gas_register_bit_width;
	uint8_t gas_register_bit_offset;
	uint8_t gas_access_size;
	uint64_t gas_address;
} __attribute__ (( packed ));

/**
 * Try to detect IPMI interface from ACPI SPMI table
 *
 * @ret interface type (1=KCS, 4=SSIF), or negative error
 */
static int ipmi_detect_acpi_spmi(void) {
	const struct acpi_spmi *spmi;

	spmi = ( const struct acpi_spmi * )
		acpi_find ( ACPI_SPMI_SIGNATURE, 0 );
	if ( !spmi ) {
		DBGC ( &ipmi_kcs_base, "IPMI: No ACPI SPMI table found\n" );
		return -ENODEV;
	}

	DBGC ( &ipmi_kcs_base, "IPMI: ACPI SPMI found — interface type %d, "
	       "address space %d, address 0x%llx\n",
	       spmi->interface_type, spmi->gas_address_space_id,
	       ( unsigned long long ) spmi->gas_address );

	/* Handle based on interface type */
	if ( spmi->interface_type == SMBIOS_IPMI_INTF_KCS ) {
		if ( spmi->gas_address_space_id != ACPI_GAS_SYSTEM_IO ) {
			DBGC ( &ipmi_kcs_base, "IPMI: ACPI SPMI KCS address "
			       "is not I/O space (space=%d)\n",
			       spmi->gas_address_space_id );
			return -ENOTSUP;
		}

		ipmi_kcs_base = ( uint16_t ) spmi->gas_address;
		/* Register spacing from GAS register_bit_width */
		if ( spmi->gas_register_bit_width > 0 )
			ipmi_kcs_spacing = spmi->gas_register_bit_width / 8;
		if ( ipmi_kcs_spacing == 0 )
			ipmi_kcs_spacing = 1;

		DBGC ( &ipmi_kcs_base, "IPMI: ACPI SPMI reports KCS at I/O "
		       "port 0x%X (spacing=%d)\n",
		       ipmi_kcs_base, ipmi_kcs_spacing );
		return SMBIOS_IPMI_INTF_KCS;
	}

	/* For SSIF, the GAS address is the SMBus slave address */
	if ( spmi->interface_type == 0x04 /* SSIF */ ) {
		uint8_t ssif_addr = ( uint8_t ) spmi->gas_address;
		DBGC ( &ipmi_kcs_base, "IPMI: ACPI SPMI reports SSIF at "
		       "SMBus address 0x%02x\n", ssif_addr );
		if ( ssif_addr )
			ipmi_ssif_set_slave_addr ( ssif_addr );
		return 0x04; /* SSIF — will be handled by SSIF driver */
	}

	DBGC ( &ipmi_kcs_base, "IPMI: ACPI SPMI interface type %d "
	       "not supported\n", spmi->interface_type );
	return -ENOTSUP;
}

/**
 * Verify KCS port responds to Get Device ID
 *
 * @ret rc	0 if verified, negative error otherwise
 */
static int kcs_verify(void) {
	struct ipmi_req req;
	struct ipmi_rs rsp;
	int rc;

	memset(&req, 0, sizeof(req));
	memset(&rsp, 0, sizeof(rsp));

	req.netfn = IPMI_NETFN_APP;
	req.cmd = IPMI_CMD_GET_DEVICE_ID;
	req.data_len = 0;

	rc = kcs_send_request(&req, &rsp);
	if (rc == 0 && rsp.ccode == 0) {
		DBGC ( &ipmi_kcs_base, "IPMI: KCS interface verified at "
		       "port 0x%X\n", ipmi_kcs_base );
		kcs_detected = 1;
		return 0;
	}

	DBGC ( &ipmi_kcs_base, "IPMI: KCS at port 0x%X not responding "
	       "(rc=%d, ccode=0x%02x)\n", ipmi_kcs_base, rc, rsp.ccode );
	return -EIO;
}

/**
 * Test if KCS interface is available
 *
 * @ret rc	Return status code (0 = available)
 */
static int kcs_detect(void) {
	/* Fallback port list if SMBIOS detection fails */
	static const unsigned int kcs_ports[] = {
		0xCA2,	/* IPMI spec default */
		0xCA0,	/* Alternative */
		0xCA8,	/* Some Dell systems */
		0xE4,	/* Some older systems */
		0xCC0,	/* Some HP systems */
	};
	unsigned int i;

	/* If already detected, just return success without re-testing */
	if (kcs_detected && ipmi_kcs_base != 0) {
		return 0;
	}

	DBGC ( &ipmi_kcs_base, "IPMI: Detecting KCS interface...\n" );

	/* Strategy 1: SMBIOS Type 38 (authoritative — firmware knows the address) */
	if (kcs_detect_smbios() == 0) {
		if (kcs_detect_port(ipmi_kcs_base) == 0 && kcs_verify() == 0)
			return 0;
		DBGC ( &ipmi_kcs_base, "IPMI: SMBIOS address 0x%X failed "
		       "verification, falling back to port scan\n",
		       ipmi_kcs_base );
	}

	/* Strategy 2: ACPI SPMI table */
	if (ipmi_detect_acpi_spmi() == SMBIOS_IPMI_INTF_KCS) {
		if (kcs_detect_port(ipmi_kcs_base) == 0 && kcs_verify() == 0)
			return 0;
		DBGC ( &ipmi_kcs_base, "IPMI: ACPI SPMI address 0x%X failed "
		       "verification, falling back to port scan\n",
		       ipmi_kcs_base );
	}

	/* Strategy 3: Probe well-known I/O ports (assume 1-byte spacing) */
	ipmi_kcs_spacing = 1;
	for (i = 0; i < (sizeof(kcs_ports) / sizeof(kcs_ports[0])); i++) {
		if (kcs_detect_port(kcs_ports[i]) == 0) {
			DBGC ( &ipmi_kcs_base, "IPMI: Found potential KCS at "
			       "port 0x%X\n", kcs_ports[i] );
			if (kcs_verify() == 0)
				return 0;
		}
	}

	DBGC ( &ipmi_kcs_base, "IPMI: No KCS interface found\n" );
	return -ENODEV;
}

/**
 * Open KCS interface
 *
 * @ret rc	Return status code
 */
static int kcs_open(void) {
	return kcs_detect();
}

/**
 * Close KCS interface
 */
static void kcs_close(void) {
	uint8_t status;
	uint8_t data __unused;
	int timeout;
	
	/* Get current status */
	status = inb(IPMI_KCS_STATUS);
	
	/* If not in idle state, try to abort current operation */
	if ((status & IPMI_KCS_STATE_MASK) != IPMI_KCS_IDLE_STATE) {
		/* Send abort command */
		outb(IPMI_KCS_ABORT, IPMI_KCS_CMD);
		
		/* Wait for IBF to clear */
		timeout = 10000;
		while (timeout-- > 0) {
			status = inb(IPMI_KCS_STATUS);
			if (!(status & IPMI_KCS_IBF))
				break;
			udelay(1);
		}
		
		/* Clear OBF if set */
		if (status & IPMI_KCS_OBF) {
			data = inb(IPMI_KCS_DATA_IN);
		}
		
		/* Read error status byte if in READ state */
		if ((status & IPMI_KCS_STATE_MASK) == IPMI_KCS_READ_STATE) {
			timeout = 10000;
			while (timeout-- > 0) {
				status = inb(IPMI_KCS_STATUS);
				if (status & IPMI_KCS_OBF) {
					data = inb(IPMI_KCS_DATA_IN);
					break;
				}
				udelay(1);
			}
		}
	}
	
	/* Final cleanup - clear any pending data */
	status = inb(IPMI_KCS_STATUS);
	if (status & IPMI_KCS_OBF) {
		data = inb(IPMI_KCS_DATA_IN);
	}
}

/** KCS interface */
static struct ipmi_intf kcs_intf = {
	.name = "KCS",
	.open = kcs_open,
	.close = kcs_close,
	.send_req = kcs_send_request,
};

/**
 * Detect interface type from SMBIOS Type 38 (any type, not just KCS)
 *
 * @ret interface type (1=KCS, 4=SSIF), or negative error
 */
static int ipmi_detect_smbios_type(void) {
	const struct smbios_ipmi_device *ipmi_dev;

	ipmi_dev = ( const struct smbios_ipmi_device * )
		smbios_structure ( SMBIOS_TYPE_IPMI_DEVICE_INFO, 0 );
	if ( !ipmi_dev )
		return -ENODEV;

	return ipmi_dev->interface_type;
}

/**
 * Initialize IPMI interface
 *
 * Detects interface type via SMBIOS/ACPI, then opens the appropriate
 * driver. Falls back to KCS port scan if detection fails.
 *
 * @ret rc	Return status code
 */
int ipmi_init(void) {
	int intf_type;

	/* Reuse previously detected interface — avoids re-running SMBIOS/ACPI
	 * detection which can corrupt KCS base address on some firmware */
	if ( current_intf )
		return 0;

	/* Check SMBIOS Type 38 for interface type */
	intf_type = ipmi_detect_smbios_type();

	/* If SMBIOS says SSIF, try transports in order:
	 *   1. EFI I2cIo SSIF (firmware publishes PI I2C stack — NVIDIA Grace)
	 *   2. SMBus-SSIF via EFI_SMBUS_HC_PROTOCOL (legacy fallback)
	 */
	if ( intf_type == IPMI_INTF_TYPE_SSIF ) {
		if ( efi_i2cio_intf.open() == 0 ) {
			current_intf = &efi_i2cio_intf;
			return 0;
		}

		/* Get slave address from SMBIOS */
		const struct smbios_ipmi_device *ipmi_dev;
		ipmi_dev = ( const struct smbios_ipmi_device * )
			smbios_structure ( SMBIOS_TYPE_IPMI_DEVICE_INFO, 0 );
		if ( ipmi_dev && ipmi_dev->i2c_slave_address )
			ipmi_ssif_set_slave_addr ( ipmi_dev->i2c_slave_address );

		if ( ssif_intf.open() == 0 ) {
			current_intf = &ssif_intf;
			return 0;
		}
	}

	/* Check ACPI SPMI for SSIF */
	intf_type = ipmi_detect_acpi_spmi();
	if ( intf_type == IPMI_INTF_TYPE_SSIF ) {
		if ( efi_i2cio_intf.open() == 0 ) {
			current_intf = &efi_i2cio_intf;
			return 0;
		}
		if ( ssif_intf.open() == 0 ) {
			current_intf = &ssif_intf;
			return 0;
		}
	}

	/* Try KCS — x86 only. KCS is port-I/O (inb/outb); on AArch64 that
	 * faults, so IPMI_HAVE_PORT_IO short-circuits the attempt and
	 * non-x86 boards fall through to -ENODEV. The autoexec's
	 * `ipmi lan || goto start` then continues to boot. */
	if ( IPMI_HAVE_PORT_IO && kcs_intf.open() == 0 ) {
		current_intf = &kcs_intf;
		return 0;
	}

	return -ENODEV;
}

/**
 * Cleanup IPMI interface
 *
 * Soft cleanup — keeps the interface open so subsequent ipmi_init()
 * calls reuse the detected driver without re-running SMBIOS/ACPI
 * detection (which can corrupt KCS state on some firmware).
 */
void ipmi_cleanup(void) {
	/* Intentionally do NOT close or NULL current_intf.
	 * The driver (KCS port / SSIF SMBus) stays open for reuse.
	 * UEFI will reclaim resources on ExitBootServices. */
}

/**
 * Send IPMI request
 *
 * @v req	IPMI request
 * @v rsp	IPMI response  
 * @ret rc	Return status code
 */
int ipmi_send_request(struct ipmi_req *req, struct ipmi_rs *rsp) {
	if (!current_intf)
		return -ENODEV;
		
	memset(rsp, 0, sizeof(*rsp));
	return current_intf->send_req(req, rsp);
}