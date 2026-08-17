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
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <ipxe/ipmi.h>
#include <ipxe/efi_smbus.h>
#include <ipxe/errfile.h>

/** @file
 *
 * IPMI SSIF (SMBus System Interface) driver
 *
 * Ported from FreeIPMI's ipmi-ssif-driver.c, adapted for UEFI
 * EFI_SMBUS_HC_PROTOCOL instead of Linux /dev/i2c-* ioctls.
 */

/** SMBus block max size (per SMBus spec) */
#define SSIF_BLOCK_MAX			32

/** SSIF SMBus command bytes (from FreeIPMI) */
#define SSIF_SINGLE_PART_WRITE_CMD	0x02
#define SSIF_MULTI_PART_WRITE_START	0x06
#define SSIF_MULTI_PART_WRITE_MIDDLE	0x07
#define SSIF_MULTI_PART_WRITE_END	0x08

#define SSIF_SINGLE_PART_READ_CMD	0x03
#define SSIF_MULTI_PART_READ_MIDDLE	0x09

/** Multi-part read detection patterns (from FreeIPMI) */
#define SSIF_MULTI_READ_START_SIZE	30
#define SSIF_MULTI_READ_START_PAT1	0x00
#define SSIF_MULTI_READ_START_PAT2	0x01
#define SSIF_MULTI_READ_END_PATTERN	0xFF

/** Default BMC slave address (0x42 per IPMI SSIF spec, matching FreeIPMI) */
#define SSIF_DEFAULT_SLAVE_ADDR		0x42

/** BMC slave address (set by detection) */
static uint8_t ssif_slave_addr = SSIF_DEFAULT_SLAVE_ADDR;

/**
 * Set SSIF slave address (called by detection code)
 *
 * @v addr	7-bit SMBus slave address
 */
void ipmi_ssif_set_slave_addr ( uint8_t addr ) {
	ssif_slave_addr = addr;
}

/**
 * Write IPMI message via SSIF single-part write
 *
 * @v buf	Message buffer (NetFn/LUN + cmd + data)
 * @v len	Message length
 * @ret rc	0 on success, negative error
 */
static int ssif_single_part_write ( const uint8_t *buf, uint8_t len ) {
	return efi_smbus_write_block ( ssif_slave_addr,
				       SSIF_SINGLE_PART_WRITE_CMD,
				       buf, len );
}

/**
 * Write IPMI message via SSIF multi-part write
 *
 * @v buf	Message buffer
 * @v len	Message length (> 32 bytes)
 * @ret rc	0 on success, negative error
 */
static int ssif_multi_part_write ( const uint8_t *buf, uint8_t len ) {
	uint8_t offset = 0;
	uint8_t chunk;
	int rc;

	/* Start block — first 32 bytes */
	rc = efi_smbus_write_block ( ssif_slave_addr,
				     SSIF_MULTI_PART_WRITE_START,
				     buf, SSIF_BLOCK_MAX );
	if ( rc != 0 )
		return rc;
	offset += SSIF_BLOCK_MAX;

	/* Middle blocks — 32 bytes each */
	while ( ( len - offset ) > SSIF_BLOCK_MAX ) {
		rc = efi_smbus_write_block ( ssif_slave_addr,
					     SSIF_MULTI_PART_WRITE_MIDDLE,
					     buf + offset, SSIF_BLOCK_MAX );
		if ( rc != 0 )
			return rc;
		offset += SSIF_BLOCK_MAX;
	}

	/* End block — remaining bytes */
	chunk = len - offset;
	return efi_smbus_write_block ( ssif_slave_addr,
				       SSIF_MULTI_PART_WRITE_END,
				       buf + offset, chunk );
}

/**
 * Read IPMI response via SSIF (handles single and multi-part)
 *
 * @v buf	Response buffer
 * @v max_len	Buffer size
 * @ret bytes read, or negative error
 */
static int ssif_read_response ( uint8_t *buf, uint16_t max_len ) {
	uint8_t block[SSIF_BLOCK_MAX + 2]; /* length byte + data */
	int block_len;
	uint16_t bytes_copied = 0;
	uint8_t sindex;
	int multi_read = 0;

	/* First read */
	block_len = efi_smbus_read_block ( ssif_slave_addr,
					   SSIF_SINGLE_PART_READ_CMD,
					   block, sizeof ( block ) );
	if ( block_len < 0 )
		return block_len;

	/* Check for multi-part read pattern:
	 * block[0] = length (30), block[1] = 0x00, block[2] = 0x01 */
	if ( block_len >= 3 &&
	     block[0] == SSIF_MULTI_READ_START_SIZE &&
	     block[1] == SSIF_MULTI_READ_START_PAT1 &&
	     block[2] == SSIF_MULTI_READ_START_PAT2 ) {
		sindex = 3; /* skip length + pattern bytes */
		multi_read = 1;
	} else {
		sindex = 1; /* skip length byte */
	}

	/* Copy first block data */
	uint16_t copy_len = block[0];
	if ( copy_len > max_len )
		copy_len = max_len;
	if ( sindex < block_len ) {
		uint16_t avail = block_len - sindex;
		if ( avail < copy_len )
			copy_len = avail;
		memcpy ( buf, block + sindex, copy_len );
		bytes_copied = copy_len;
	}

	/* Multi-part read: keep reading middle/end blocks */
	while ( multi_read ) {
		block_len = efi_smbus_read_block ( ssif_slave_addr,
						   SSIF_MULTI_PART_READ_MIDDLE,
						   block, sizeof ( block ) );
		if ( block_len < 2 )
			break;

		uint8_t length = block[0];
		uint8_t block_number = block[1];

		/* Copy data (skip length + block_number) */
		uint16_t data_len = length;
		if ( ( bytes_copied + data_len ) > max_len )
			data_len = max_len - bytes_copied;
		if ( data_len > 0 && block_len > 2 ) {
			uint16_t avail = block_len - 2;
			if ( avail < data_len )
				data_len = avail;
			memcpy ( buf + bytes_copied, block + 2, data_len );
			bytes_copied += data_len;
		}

		/* End pattern */
		if ( block_number == SSIF_MULTI_READ_END_PATTERN )
			break;
	}

	return bytes_copied;
}

/**
 * Send IPMI request via SSIF and receive response
 *
 * @v req	IPMI request
 * @v rsp	IPMI response
 * @ret rc	0 on success, negative error
 */
static int ssif_send_request ( struct ipmi_req *req, struct ipmi_rs *rsp ) {
	uint8_t write_buf[2 + 256]; /* NetFn/LUN + cmd + data */
	uint8_t read_buf[256];
	int write_len = 0;
	int read_len;
	int rc;

	/* Build IPMI message */
	write_buf[write_len++] = req->netfn << 2; /* NetFn/LUN */
	write_buf[write_len++] = req->cmd;
	if ( req->data_len > 0 ) {
		memcpy ( write_buf + write_len, req->data, req->data_len );
		write_len += req->data_len;
	}

	/* Write request */
	if ( write_len <= SSIF_BLOCK_MAX )
		rc = ssif_single_part_write ( write_buf, write_len );
	else
		rc = ssif_multi_part_write ( write_buf, write_len );

	if ( rc != 0 )
		return rc;

	/* Read response */
	memset ( rsp, 0, sizeof ( *rsp ) );
	read_len = ssif_read_response ( read_buf, sizeof ( read_buf ) );
	if ( read_len < 0 )
		return read_len;

	/* Parse response: NetFn/LUN (1) + cmd (1) + ccode (1) + data */
	if ( read_len >= 3 ) {
		/* Skip NetFn/LUN (byte 0) and cmd echo (byte 1) */
		rsp->ccode = read_buf[2];
		int data_len = read_len - 3;
		if ( data_len > ( int ) sizeof ( rsp->data ) )
			data_len = sizeof ( rsp->data );
		if ( data_len > 0 ) {
			memcpy ( rsp->data, read_buf + 3, data_len );
			rsp->data_len = data_len;
		}
	} else if ( read_len > 0 ) {
		/* Short response — treat as error */
		return -EIO;
	}

	return 0;
}

/**
 * Open SSIF interface via UEFI SMBus
 *
 * @ret rc	0 on success, negative error
 */
static int ssif_open ( void ) {
	int rc;

	rc = efi_smbus_init();
	if ( rc != 0 ) {
		DBGC ( &ssif_slave_addr, "IPMI SSIF: No UEFI SMBus Host "
		       "Controller Protocol available\n" );
		return rc;
	}

	DBGC ( &ssif_slave_addr, "IPMI SSIF: Opened SMBus interface, "
	       "slave address 0x%02x\n", ssif_slave_addr );
	return 0;
}

/**
 * Close SSIF interface
 */
static void ssif_close ( void ) {
	/* Nothing to clean up — UEFI protocol doesn't need explicit close */
}

/** SSIF interface */
struct ipmi_intf ssif_intf = {
	.name = "SSIF",
	.open = ssif_open,
	.close = ssif_close,
	.send_req = ssif_send_request,
};
