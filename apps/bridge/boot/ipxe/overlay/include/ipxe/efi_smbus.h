#ifndef _IPXE_EFI_SMBUS_H
#define _IPXE_EFI_SMBUS_H

/** @file
 *
 * UEFI SMBus Host Controller Protocol wrapper for IPMI SSIF
 *
 */

FILE_LICENCE ( GPL2_OR_LATER_OR_UBDL );

#include <ipxe/efi/efi.h>

/** EFI SMBus Host Controller Protocol GUID */
#define EFI_SMBUS_HC_PROTOCOL_GUID					\
	{ 0xe49d33ed, 0x513d, 0x4634,					\
	  { 0xb6, 0x98, 0x6f, 0x55, 0xaa, 0x75, 0x1c, 0x1b } }

/** SMBus device address (7-bit) */
typedef struct {
	UINTN SmbusDeviceAddress;
} EFI_SMBUS_DEVICE_ADDRESS;

/** SMBus command byte */
typedef UINTN EFI_SMBUS_DEVICE_COMMAND;

/** SMBus operation types */
typedef enum {
	EfiSmbusQuickRead,
	EfiSmbusQuickWrite,
	EfiSmbusReceiveByte,
	EfiSmbusSendByte,
	EfiSmbusReadByte,
	EfiSmbusWriteByte,
	EfiSmbusReadWord,
	EfiSmbusWriteWord,
	EfiSmbusReadBlock,
	EfiSmbusWriteBlock,
	EfiSmbusProcessCall,
	EfiSmbusBWBRProcessCall,
} EFI_SMBUS_OPERATION;

/** Forward declaration */
typedef struct _EFI_SMBUS_HC_PROTOCOL EFI_SMBUS_HC_PROTOCOL;

/** SMBus Execute function */
typedef EFI_STATUS ( EFIAPI *EFI_SMBUS_HC_EXECUTE_OPERATION ) (
	IN CONST EFI_SMBUS_HC_PROTOCOL *This,
	IN EFI_SMBUS_DEVICE_ADDRESS SlaveAddress,
	IN EFI_SMBUS_DEVICE_COMMAND Command,
	IN EFI_SMBUS_OPERATION Operation,
	IN BOOLEAN PecCheck,
	IN OUT UINTN *Length,
	IN OUT VOID *Buffer
);

/** SMBus Host Controller Protocol */
struct _EFI_SMBUS_HC_PROTOCOL {
	EFI_SMBUS_HC_EXECUTE_OPERATION Execute;
	/* ArpDevice, GetArpMap, Notify omitted — not needed for IPMI */
};

/* Wrapper functions */
extern int efi_smbus_init ( void );
extern int efi_smbus_write_block ( uint8_t slave_addr, uint8_t cmd,
				   const void *data, uint8_t len );
extern int efi_smbus_read_block ( uint8_t slave_addr, uint8_t cmd,
				  void *data, uint8_t max_len );

#endif /* _IPXE_EFI_SMBUS_H */
