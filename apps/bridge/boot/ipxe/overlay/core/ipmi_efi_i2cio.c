/*
 * Copyright (C) 2026 iPXE Contributors
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
#include <errno.h>
#include <unistd.h>
#include <ipxe/efi/efi.h>
#include <ipxe/ipmi.h>

/** @file
 *
 * IPMI driver layered over UEFI EFI_I2C_IO_PROTOCOL.
 *
 * Used on platforms where the firmware publishes the PI I2C stack to
 * boot applications but NOT a higher-level IpmiTransport (NVIDIA Grace
 * AMI Aptio is the empirical case). We find the BMC's I2cIo handle by
 * matching DeviceGuid against a list of known vendor BMC GUIDs, then
 * speak SSIF (IPMI 2.0 spec) directly: SMBus block write (cmd 0x02) for
 * requests, SMBus block read (cmd 0x03) for responses, polling with
 * backoff between because SSIF is by design two separate transactions.
 *
 * Only single-part SSIF (<=32 byte block) is implemented; the IPMI
 * commands iPXE issues (Get Channel Info, Get LAN Config, Get Device
 * ID, Get DCMI Asset Tag) all fit. Multi-part SSIF can be added later
 * if some IPMI extension grows beyond 32 bytes.
 */

/** EFI_I2C_OPERATION (PI Vol 5). Flags bit 0 = READ. */
typedef struct {
	UINT32 Flags;
	UINT32 LengthInBytes;
	UINT8 *Buffer;
} efi_i2c_op_t;

#define EFI_I2C_FLAG_READ 0x00000001

/** EFI_I2C_REQUEST_PACKET (PI Vol 5). Variable-length tail. */
typedef struct {
	UINTN OperationCount;
	efi_i2c_op_t Operation[3];
} efi_i2c_packet_t;

struct efi_i2c_io_proto;

/** EFI_I2C_IO_PROTOCOL.QueueRequest signature (sync when Event==NULL). */
typedef EFI_STATUS ( EFIAPI *efi_i2c_io_queue_req_t ) (
	const struct efi_i2c_io_proto *This,
	UINTN SlaveAddressIndex,
	VOID *Event,
	VOID *RequestPacket,
	EFI_STATUS *I2cStatus
);

/** Layout-compatible mirror of EDK2's EFI_I2C_IO_PROTOCOL. */
typedef struct efi_i2c_io_proto {
	efi_i2c_io_queue_req_t QueueRequest;
	const EFI_GUID *DeviceGuid;
	UINT32 DeviceIndex;
	UINT32 HardwareRevision;
	const VOID *I2cControllerCapabilities;
} efi_i2c_io_proto_t;

/** EFI_I2C_IO_PROTOCOL GUID. */
static EFI_GUID efi_i2cio_proto_guid = {
	0xb60a3e6b, 0x18c4, 0x46e5,
	{ 0xa2, 0x9a, 0xc9, 0xa1, 0x06, 0x65, 0xa2, 0x8e }
};

/** Known BMC I2cIo DeviceGuids. iPXE matches each I2cIo handle's
 *  DeviceGuid against this list to find the BMC handle deterministically
 *  without slave-address scanning. Add new vendors as encountered. */
static const EFI_GUID known_bmc_guids[] = {
	/* NVIDIA Grace (TegraI2cDxe assigns this to the "ssif-bmc"
	 * device-tree node it discovers). */
	{ 0xb4fcca9e, 0x93ec, 0x4fb5,
	  { 0x87, 0x81, 0x54, 0x07, 0x0c, 0x54, 0x39, 0x06 } },
};

/** SSIF SMBus command bytes (IPMI 2.0 SSIF spec). */
#define SSIF_CMD_SINGLE_WRITE 0x02
#define SSIF_CMD_SINGLE_READ  0x03

/** SSIF read polling budget: 50 attempts * 10ms = 500ms total.
 *  BMCs on observed hardware respond in ~10ms; budget covers the slow
 *  ones FreeIPMI handles similarly. */
#define SSIF_READ_MAX_ATTEMPTS 50
#define SSIF_READ_RETRY_MS 10

/** Single-part SSIF block max (per SMBus spec). */
#define SSIF_BLOCK_MAX 32

/** Cached BMC I2cIo protocol pointer set by open(). */
static efi_i2c_io_proto_t *bmc_i2cio = NULL;

/**
 * Walk I2cIo handles and bind to the first whose DeviceGuid matches a
 * known BMC vendor GUID.
 *
 * @ret rc	0 on success, -ENODEV if no matching handle exists
 */
static int efi_i2cio_find_bmc ( void ) {
	EFI_BOOT_SERVICES *bs = efi_systab->BootServices;
	UINTN count = 0;
	EFI_HANDLE *handles = NULL;
	EFI_STATUS efirc;
	unsigned int i, j;

	DBGC ( &bmc_i2cio, "IPMI I2cIo: locating EFI_I2C_IO handles\n" );
	efirc = bs->LocateHandleBuffer ( ByProtocol, &efi_i2cio_proto_guid,
					 NULL, &count, &handles );
	if ( efirc != 0 ) {
		DBGC ( &bmc_i2cio, "IPMI I2cIo: LocateHandleBuffer"
		       " efirc=%lx\n", ( unsigned long ) efirc );
		return -ENODEV;
	}
	DBGC ( &bmc_i2cio, "IPMI I2cIo: walking %d I2cIo handle(s) for"
	       " known BMC GUID\n", ( int ) count );

	for ( i = 0; i < count; i++ ) {
		efi_i2c_io_proto_t *io = NULL;
		efirc = bs->HandleProtocol ( handles[i],
					     &efi_i2cio_proto_guid,
					     ( void ** ) &io );
		if ( efirc != 0 || io == NULL || io->DeviceGuid == NULL ) {
			DBGC ( &bmc_i2cio, "IPMI I2cIo:   handle[%d]:"
			       " HandleProtocol failed\n", i );
			continue;
		}
		/* Log the full 16-byte DeviceGuid so a new platform's BMC
		 * handle can be transcribed straight into known_bmc_guids[]
		 * (see IPMI_PLATFORM_BRINGUP.md). Build DEBUG=ipmi_efi_i2cio
		 * and boot on the target to capture it. */
		DBGC ( &bmc_i2cio, "IPMI I2cIo:   handle[%d]: DeviceGuid="
		       "%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x\n", i,
		       ( int ) io->DeviceGuid->Data1,
		       ( int ) io->DeviceGuid->Data2,
		       ( int ) io->DeviceGuid->Data3,
		       io->DeviceGuid->Data4[0], io->DeviceGuid->Data4[1],
		       io->DeviceGuid->Data4[2], io->DeviceGuid->Data4[3],
		       io->DeviceGuid->Data4[4], io->DeviceGuid->Data4[5],
		       io->DeviceGuid->Data4[6], io->DeviceGuid->Data4[7] );

		for ( j = 0; j < ( sizeof ( known_bmc_guids ) /
				   sizeof ( known_bmc_guids[0] ) ); j++ ) {
			if ( memcmp ( io->DeviceGuid, &known_bmc_guids[j],
				      sizeof ( EFI_GUID ) ) == 0 ) {
				DBGC ( &bmc_i2cio, "IPMI I2cIo: matched"
				       " known BMC GUID #%d at handle[%d]\n",
				       j, i );
				bmc_i2cio = io;
				bs->FreePool ( handles );
				return 0;
			}
		}
	}

	DBGC ( &bmc_i2cio, "IPMI I2cIo: no handle matched a known BMC"
	       " GUID across %d I2cIo handle(s)\n", ( int ) count );
	bs->FreePool ( handles );
	return -ENODEV;
}

static int efi_i2cio_open ( void ) {
	int rc;

	if ( bmc_i2cio )
		return 0;

	rc = efi_i2cio_find_bmc();
	if ( rc != 0 ) {
		DBGC ( &bmc_i2cio, "IPMI I2cIo: no I2cIo handle matched a"
		       " known BMC DeviceGuid\n" );
		return rc;
	}

	DBGC ( &bmc_i2cio, "IPMI I2cIo: bound to BMC I2cIo handle\n" );
	return 0;
}

static void efi_i2cio_close ( void ) {
	bmc_i2cio = NULL;
}

static int efi_i2cio_send_request ( struct ipmi_req *req,
				    struct ipmi_rs *rsp ) {
	/* SSIF single-part write fits the SMBus block: 1 SSIF cmd byte +
	 * 1 length byte + up to SSIF_BLOCK_MAX bytes of IPMI message.
	 * msg_len is bounded below; sizing tracks that bound. */
	UINT8 write_buf[2 + SSIF_BLOCK_MAX];
	UINT8 read_cmd = SSIF_CMD_SINGLE_READ;
	/* SSIF single-part read returns at most 1 length byte + 32 data
	 * bytes per SMBus spec (+1 optional PEC). Zero-init so partial
	 * transfers don't leak stack residue into rsp->data. */
	UINT8 read_buf[1 + SSIF_BLOCK_MAX + 1] = { 0 };
	efi_i2c_packet_t write_pkt;
	efi_i2c_packet_t read_pkt;
	EFI_STATUS efirc;
	unsigned int i;
	unsigned int msg_len;
	UINT8 rsp_len_byte;

	if ( ! bmc_i2cio )
		return -ENODEV;

	DBGC ( &bmc_i2cio, "IPMI I2cIo: req netfn=0x%02x cmd=0x%02x"
	       " data_len=%d\n", req->netfn, req->cmd,
	       ( int ) req->data_len );

	/* IPMI message is [NetFn|LUN, Cmd, data]. SSIF wraps as
	 * [SMBus cmd, length, IPMI message]. We don't yet support
	 * multi-part, so fail loudly if the request exceeds one block. */
	msg_len = 2 + req->data_len;
	if ( msg_len > SSIF_BLOCK_MAX ) {
		DBGC ( &bmc_i2cio, "IPMI I2cIo: req exceeds %d-byte SSIF"
		       " block (msg_len=%d)\n", SSIF_BLOCK_MAX,
		       ( int ) msg_len );
		return -ERANGE;
	}

	write_buf[0] = SSIF_CMD_SINGLE_WRITE;
	write_buf[1] = msg_len;
	write_buf[2] = req->netfn << 2;
	write_buf[3] = req->cmd;
	if ( req->data_len > 0 )
		memcpy ( write_buf + 4, req->data, req->data_len );

	write_pkt.OperationCount = 1;
	write_pkt.Operation[0].Flags = 0;
	write_pkt.Operation[0].LengthInBytes = 2 + msg_len;
	write_pkt.Operation[0].Buffer = write_buf;

	efirc = bmc_i2cio->QueueRequest ( bmc_i2cio, 0, NULL,
					  &write_pkt, NULL );
	if ( efirc != 0 ) {
		DBGC ( &bmc_i2cio, "IPMI I2cIo: SSIF write QueueRequest"
		       " efirc=%lx\n", ( unsigned long ) efirc );
		return -EIO;
	}

	/* Poll for the response: BMC needs processing time between
	 * accepting the SSIF write and being ready to serve the read.
	 * NACKs surface as EFI_NO_RESPONSE; retry with backoff. */
	read_pkt.OperationCount = 2;
	read_pkt.Operation[0].Flags = 0;
	read_pkt.Operation[0].LengthInBytes = 1;
	read_pkt.Operation[0].Buffer = &read_cmd;
	read_pkt.Operation[1].Flags = EFI_I2C_FLAG_READ;
	read_pkt.Operation[1].LengthInBytes = sizeof ( read_buf );
	read_pkt.Operation[1].Buffer = read_buf;

	for ( i = 0; i < SSIF_READ_MAX_ATTEMPTS; i++ ) {
		mdelay ( SSIF_READ_RETRY_MS );
		efirc = bmc_i2cio->QueueRequest ( bmc_i2cio, 0, NULL,
						  &read_pkt, NULL );
		if ( efirc == 0 ) {
			DBGC ( &bmc_i2cio, "IPMI I2cIo: SSIF read succeeded"
			       " on attempt %d (~%dms wait)\n",
			       ( int )( i + 1 ),
			       ( int )( ( i + 1 ) * SSIF_READ_RETRY_MS ) );
			break;
		}
	}
	if ( efirc != 0 ) {
		DBGC ( &bmc_i2cio, "IPMI I2cIo: SSIF read failed after %d"
		       " attempts efirc=%lx\n", SSIF_READ_MAX_ATTEMPTS,
		       ( unsigned long ) efirc );
		return -EIO;
	}

	/* Parse SSIF response: [len, NetFn echo, Cmd echo, ccode, data...].
	 * Bound rsp_len_byte to [3, SSIF_BLOCK_MAX] so a malformed or buggy
	 * BMC length byte can't drive memcpy past the actual SMBus block
	 * into uninitialised tail bytes of read_buf. */
	rsp_len_byte = read_buf[0];
	if ( rsp_len_byte < 3 || rsp_len_byte > SSIF_BLOCK_MAX ) {
		DBGC ( &bmc_i2cio, "IPMI I2cIo: SSIF response len=%d outside"
		       " [3, %d]\n", ( int ) rsp_len_byte, SSIF_BLOCK_MAX );
		return -EIO;
	}

	/* Verify NetFn/LUN and Cmd echoes match the request (IPMI 2.0
	 * §7.7: response NetFn = request NetFn | 1, response LUN = request
	 * LUN, response Cmd echoes the request Cmd). Catches out-of-order
	 * responses and BMC firmware bugs that would otherwise feed garbage
	 * into the IPMI parsing layers. */
	{
		UINT8 expected_netfn_lun = ( req->netfn | 1 ) << 2;
		if ( read_buf[1] != expected_netfn_lun ||
		     read_buf[2] != req->cmd ) {
			DBGC ( &bmc_i2cio, "IPMI I2cIo: response echo mismatch"
			       " (expected NetFn|LUN=0x%02x Cmd=0x%02x, got"
			       " 0x%02x 0x%02x)\n",
			       expected_netfn_lun, req->cmd,
			       read_buf[1], read_buf[2] );
			return -EIO;
		}
	}

	rsp->ccode = read_buf[3];
	rsp->data_len = rsp_len_byte - 3;
	if ( rsp->data_len > 0 )
		memcpy ( rsp->data, read_buf + 4, rsp->data_len );

	DBGC ( &bmc_i2cio, "IPMI I2cIo: rsp ccode=0x%02x data_len=%d\n",
	       rsp->ccode, ( int ) rsp->data_len );
	return 0;
}

struct ipmi_intf efi_i2cio_intf = {
	.name = "EFI_I2cIo",
	.open = efi_i2cio_open,
	.close = efi_i2cio_close,
	.send_req = efi_i2cio_send_request,
};
