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
#include <errno.h>
#include <ipxe/efi/efi.h>
#include <ipxe/efi_smbus.h>

/** @file
 *
 * UEFI SMBus Host Controller Protocol wrapper
 *
 */

/** SMBus HC Protocol instance */
static EFI_SMBUS_HC_PROTOCOL *smbus_hc = NULL;

/** SMBus HC Protocol GUID */
static EFI_GUID efi_smbus_hc_protocol_guid = EFI_SMBUS_HC_PROTOCOL_GUID;

/**
 * Locate and initialize UEFI SMBus Host Controller Protocol
 *
 * @ret rc	0 on success, negative error on failure
 */
int efi_smbus_init ( void ) {
	EFI_BOOT_SERVICES *bs = efi_systab->BootServices;
	EFI_STATUS efirc;

	if ( smbus_hc )
		return 0;

	efirc = bs->LocateProtocol ( &efi_smbus_hc_protocol_guid,
				     NULL, ( void ** ) &smbus_hc );
	if ( efirc != 0 ) {
		smbus_hc = NULL;
		return -ENODEV;
	}

	return 0;
}

/**
 * Write a block of data via SMBus
 *
 * @v slave_addr	7-bit SMBus slave address
 * @v cmd		SMBus command byte
 * @v data		Data to write
 * @v len		Length of data
 * @ret rc		0 on success, negative error on failure
 */
int efi_smbus_write_block ( uint8_t slave_addr, uint8_t cmd,
			    const void *data, uint8_t len ) {
	EFI_SMBUS_DEVICE_ADDRESS addr;
	UINTN length = len;
	EFI_STATUS efirc;

	if ( !smbus_hc )
		return -ENODEV;

	addr.SmbusDeviceAddress = slave_addr;

	efirc = smbus_hc->Execute ( smbus_hc, addr, cmd,
				    EfiSmbusWriteBlock, FALSE,
				    &length, ( void * ) data );
	if ( efirc != 0 )
		return -EIO;

	return 0;
}

/**
 * Read a block of data via SMBus
 *
 * @v slave_addr	7-bit SMBus slave address
 * @v cmd		SMBus command byte
 * @v data		Buffer to read into
 * @v max_len		Maximum bytes to read
 * @ret bytes read, or negative error
 */
int efi_smbus_read_block ( uint8_t slave_addr, uint8_t cmd,
			   void *data, uint8_t max_len ) {
	EFI_SMBUS_DEVICE_ADDRESS addr;
	UINTN length = max_len;
	EFI_STATUS efirc;

	if ( !smbus_hc )
		return -ENODEV;

	addr.SmbusDeviceAddress = slave_addr;

	efirc = smbus_hc->Execute ( smbus_hc, addr, cmd,
				    EfiSmbusReadBlock, FALSE,
				    &length, data );
	if ( efirc != 0 )
		return -EIO;

	return ( int ) length;
}
