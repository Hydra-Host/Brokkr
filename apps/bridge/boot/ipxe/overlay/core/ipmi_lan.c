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
#include <stdlib.h>
#include <errno.h>
#include <ipxe/ipmi.h>
#include <ipxe/errfile.h>
#include <ipxe/in.h>
#include <ipxe/if_ether.h>

/** @file
 *
 * IPMI LAN Configuration
 *
 */



struct lan_param {
	uint8_t param;
	uint8_t len;
	const char *desc;
};

/** LAN configuration parameters */
static const struct lan_param lan_params[] __unused = {
	{ IPMI_LAN_SET_IN_PROGRESS,	1, "Set in Progress" },
	{ IPMI_LAN_AUTH_TYPE,		1, "Auth Type Support" },
	{ IPMI_LAN_AUTH_TYPE_ENABLE,	5, "Auth Type Enable" },
	{ IPMI_LAN_IP_ADDR,		4, "IP Address" },
	{ IPMI_LAN_IP_ADDR_SRC,		1, "IP Address Source" },
	{ IPMI_LAN_MAC_ADDR,		6, "MAC Address" },
	{ IPMI_LAN_SUBNET_MASK,		4, "Subnet Mask" },
	{ IPMI_LAN_IP_HEADER,		4, "IP Header" },
	{ IPMI_LAN_PRI_RMCP_PORT,	2, "Primary RMCP Port" },
	{ IPMI_LAN_SEC_RMCP_PORT,	2, "Secondary RMCP Port" },
	{ IPMI_LAN_BMC_ARP_CTRL,	1, "BMC ARP Control" },
	{ IPMI_LAN_GRAT_ARP_INTERVAL,	1, "Gratuitous ARP Intrvl" },
	{ IPMI_LAN_DEF_GATEWAY_IP,	4, "Default Gateway IP" },
	{ IPMI_LAN_DEF_GATEWAY_MAC,	6, "Default Gateway MAC" },
	{ IPMI_LAN_BAK_GATEWAY_IP,	4, "Backup Gateway IP" },
	{ IPMI_LAN_BAK_GATEWAY_MAC,	6, "Backup Gateway MAC" },
	{ IPMI_LAN_VLAN_ID,		3, "802.1q VLAN ID" },
	{ IPMI_LAN_VLAN_PRIORITY,	1, "802.1q VLAN Priority" },
	{ 0, 0, NULL }
};

/**
 * Get LAN configuration parameter
 *
 * @v channel	Channel number
 * @v param	Parameter selector
 * @v set	Parameter set
 * @v block	Parameter block
 * @v rsp	Response structure
 * @ret rc	Return status code
 */
static int get_lan_param(uint8_t channel, uint8_t param, uint8_t set,
			uint8_t block, struct ipmi_rs *rsp) {
	struct ipmi_req req;

	memset(&req, 0, sizeof(req));
	req.netfn = IPMI_NETFN_TRANSPORT;
	req.cmd = IPMI_CMD_GET_LAN_CONFIG;
	req.data_len = 4;
	req.data[0] = channel;
	req.data[1] = param;
	req.data[2] = set;
	req.data[3] = block;

	return ipmi_send_request(&req, rsp);
}

/**
 * Find LAN channel
 *
 * @ret channel	LAN channel number or negative error
 */
static int find_lan_channel(void) {
	struct ipmi_req req;
	struct ipmi_rs rsp;
	int channel;

	/* Try channels 1-14 */
	for (channel = 1; channel <= 14; channel++) {
		memset(&req, 0, sizeof(req));
		req.netfn = IPMI_NETFN_APP;
		req.cmd = IPMI_CMD_GET_CHANNEL_INFO;
		req.data_len = 1;
		req.data[0] = channel;

		if (ipmi_send_request(&req, &rsp) == 0 && rsp.ccode == IPMI_CC_OK) {
			/* Accept either 802.3 LAN or non-802.3 "Other LAN" —
			 * matches ipmitool's is_lan_channel() (ipmi_lanp.c:148). */
			if (rsp.data_len >= 2) {
				uint8_t medium = rsp.data[1] & 0x7F;
				if (medium == IPMI_CHANNEL_MEDIUM_LAN ||
				    medium == IPMI_CHANNEL_MEDIUM_LAN_OTHER) {
					return channel;
				}
			}
		}
	}

	return -ENODEV;
}

/**
 * IPMI LAN print command — silently queries BMC LAN settings and
 * stores IP, MAC, netmask, and gateway into iPXE settings variables.
 *
 * @v argc	Argument count
 * @v argv	Argument list
 * @ret rc	Return status code
 */
int ipmi_lan_print(int argc, char **argv) {
	struct ipmi_rs rsp;
	int channel = 0;
	int rc;

	/* Parse arguments */
	if (argc > 1) {
		channel = strtoul(argv[1], NULL, 0);
		if (channel < 1 || channel > 14) {
			return -EINVAL;
		}
	} else {
		/* Find first LAN channel */
		channel = find_lan_channel();
		if (channel < 0) {
			return channel;
		}
	}

	struct in_addr ip_addr = { 0 };
	if ((rc = get_lan_param(channel, IPMI_LAN_IP_ADDR, 0, 0, &rsp)) == 0
	    && rsp.ccode == IPMI_CC_OK && rsp.data_len >= 5) {
		memcpy(&ip_addr, &rsp.data[1], sizeof(ip_addr));
	}

	uint8_t mac_addr[6] = { 0 };
	if ((rc = get_lan_param(channel, IPMI_LAN_MAC_ADDR, 0, 0, &rsp)) == 0
	    && rsp.ccode == IPMI_CC_OK && rsp.data_len >= 7) {
		memcpy(mac_addr, &rsp.data[1], sizeof(mac_addr));
	}

	struct in_addr netmask = { 0 };
	if ((rc = get_lan_param(channel, IPMI_LAN_SUBNET_MASK, 0, 0, &rsp)) == 0
	    && rsp.ccode == IPMI_CC_OK && rsp.data_len >= 5) {
		memcpy(&netmask, &rsp.data[1], sizeof(netmask));
	}

	struct in_addr gateway = { 0 };
	if ((rc = get_lan_param(channel, IPMI_LAN_DEF_GATEWAY_IP, 0, 0, &rsp)) == 0
	    && rsp.ccode == IPMI_CC_OK && rsp.data_len >= 5) {
		memcpy(&gateway, &rsp.data[1], sizeof(gateway));
	}

	/* Store settings in iPXE variables */
	if ( ip_addr.s_addr || mac_addr[0] || mac_addr[1] || mac_addr[2] ||
	     mac_addr[3] || mac_addr[4] || mac_addr[5] ||
	     netmask.s_addr || gateway.s_addr ) {
		ipmi_store_lan_settings ( ip_addr, mac_addr, netmask, gateway );
	}

	return 0;
}
