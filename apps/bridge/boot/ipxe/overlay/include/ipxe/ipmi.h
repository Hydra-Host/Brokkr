#ifndef _IPXE_IPMI_H
#define _IPXE_IPMI_H

/** @file
 *
 * Intelligent Platform Management Interface (IPMI)
 *
 */

FILE_LICENCE ( GPL2_OR_LATER_OR_UBDL );

#include <stdint.h>
#include <ipxe/io.h>

/** IPMI NetFn values */
#define IPMI_NETFN_APP			0x06
#define IPMI_NETFN_TRANSPORT		0x0C
#define IPMI_NETFN_DCGRP		0x2C

/** IPMI Commands */
#define IPMI_CMD_GET_DEVICE_ID		0x01
#define IPMI_CMD_GET_LAN_CONFIG		0x02
#define IPMI_CMD_GET_CHANNEL_INFO	0x42

/** DCMI Commands */
#define IPMI_DCMI_GET_ASSET_TAG		0x06

/** IPMI completion codes */
#define IPMI_CC_OK			0x00
#define IPMI_CC_NODE_BUSY		0xC0
#define IPMI_CC_INVALID_CMD		0xC1
#define IPMI_CC_TIMEOUT			0xC3

/** KCS Interface registers - set dynamically via SMBIOS or port probing */
extern unsigned int ipmi_kcs_base;
extern unsigned int ipmi_kcs_spacing;
#define IPMI_KCS_DATA_IN		(ipmi_kcs_base + 0)
#define IPMI_KCS_DATA_OUT		(ipmi_kcs_base + 0)
#define IPMI_KCS_CMD			(ipmi_kcs_base + ipmi_kcs_spacing)
#define IPMI_KCS_STATUS			(ipmi_kcs_base + ipmi_kcs_spacing)

/** KCS Status bits */
#define IPMI_KCS_OBF			0x01
#define IPMI_KCS_IBF			0x02
#define IPMI_KCS_STATE_MASK		0xC0
#define IPMI_KCS_IDLE_STATE		0x00
#define IPMI_KCS_READ_STATE		0x40
#define IPMI_KCS_WRITE_STATE		0x80
#define IPMI_KCS_ERROR_STATE		0xC0

/** KCS Commands */
#define IPMI_KCS_WRITE_START		0x61
#define IPMI_KCS_WRITE_END		0x62
#define IPMI_KCS_GET_STATUS		0x60
#define IPMI_KCS_ABORT			0x60
#define IPMI_KCS_READ			0x68

/** IPMI Channel Medium Types (IPMI v2.0 spec Table 6-3) */
#define IPMI_CHANNEL_MEDIUM_LAN		0x04	/* 802.3 LAN */
#define IPMI_CHANNEL_MEDIUM_LAN_OTHER	0x06	/* Non-802.3 LAN */

/** IPMI LAN Parameters */
#define IPMI_LAN_SET_IN_PROGRESS	0
#define IPMI_LAN_AUTH_TYPE		1
#define IPMI_LAN_AUTH_TYPE_ENABLE	2
#define IPMI_LAN_IP_ADDR		3
#define IPMI_LAN_IP_ADDR_SRC		4
#define IPMI_LAN_MAC_ADDR		5
#define IPMI_LAN_SUBNET_MASK		6
#define IPMI_LAN_IP_HEADER		7
#define IPMI_LAN_PRI_RMCP_PORT		8
#define IPMI_LAN_SEC_RMCP_PORT		9
#define IPMI_LAN_BMC_ARP_CTRL		10
#define IPMI_LAN_GRAT_ARP_INTERVAL	11
#define IPMI_LAN_DEF_GATEWAY_IP		12
#define IPMI_LAN_DEF_GATEWAY_MAC	13
#define IPMI_LAN_BAK_GATEWAY_IP		14
#define IPMI_LAN_BAK_GATEWAY_MAC	15
#define IPMI_LAN_VLAN_ID		20
#define IPMI_LAN_VLAN_PRIORITY		21

/** IPMI request structure */
struct ipmi_req {
	uint8_t netfn;
	uint8_t cmd;
	uint8_t data_len;
	uint8_t data[256];
};

/** IPMI response structure */
struct ipmi_rs {
	uint8_t ccode;
	uint16_t data_len;
	uint8_t data[256];
};

/** IPMI interface structure */
struct ipmi_intf {
	const char *name;
	int (*open)(void);
	void (*close)(void);
	int (*send_req)(struct ipmi_req *req, struct ipmi_rs *rsp);
};

/** SSIF interface type (SMBIOS/ACPI value) */
#define IPMI_INTF_TYPE_SSIF		0x04

/* Function declarations */
extern int ipmi_init(void);
extern void ipmi_cleanup(void);
extern int ipmi_send_request(struct ipmi_req *req, struct ipmi_rs *rsp);
extern int ipmi_lan_print(int argc, char **argv);
extern int ipmi_dcmi_asset_tag(int argc, char **argv);

/* SSIF interface */
extern struct ipmi_intf ssif_intf;
extern void ipmi_ssif_set_slave_addr ( uint8_t addr );

/* EFI I2cIo-SSIF interface (firmware-mediated I2C transport + iPXE-side
 * SSIF framing; used on platforms that expose the PI I2C stack —
 * NVIDIA Grace AMI Aptio is the verified case) */
extern struct ipmi_intf efi_i2cio_intf;

/* Include necessary headers for settings */
#include <ipxe/in.h>

/* IPMI settings functions */
extern int ipmi_store_lan_settings ( struct in_addr ip_addr, uint8_t *mac_addr,
				      struct in_addr netmask, struct in_addr gateway );
extern int ipmi_store_tag_setting ( const char *tag );

#endif /* _IPXE_IPMI_H */