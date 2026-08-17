/*
 * Copyright (C) 2024 iPXE Contributors.
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

FILE_LICENCE ( GPL2_OR_LATER );

#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <ipxe/settings.h>
#include <ipxe/init.h>
#include <ipxe/ipmi.h>
#include <ipxe/if_ether.h>

/** @file
 *
 * IPMI settings
 *
 */

/** IPMI settings scope */
static const struct settings_scope ipmi_settings_scope;

/** IPMI generic settings block */
static struct generic_settings ipmi_generic_settings = {
	.settings = {
		.refcnt = NULL,
		.siblings = LIST_HEAD_INIT ( ipmi_generic_settings.settings.siblings ),
		.children = LIST_HEAD_INIT ( ipmi_generic_settings.settings.children ),
		.op = &generic_settings_operations,
		.default_scope = &ipmi_settings_scope,
	},
	.list = LIST_HEAD_INIT ( ipmi_generic_settings.list ),
};

/** IPMI settings block */
#define ipmi_settings ipmi_generic_settings.settings

/** IPMI IP address setting */
static const struct setting ipmi_ip_setting = {
	.name = "ip",
	.description = "IPMI BMC IP address",
	.type = &setting_type_ipv4,
	.scope = &ipmi_settings_scope,
};

/** IPMI MAC address setting */
static const struct setting ipmi_mac_setting = {
	.name = "mac", 
	.description = "IPMI BMC MAC address",
	.type = &setting_type_hexhyp,
	.scope = &ipmi_settings_scope,
};

/** IPMI netmask setting */
static const struct setting ipmi_mask_setting = {
	.name = "mask",
	.description = "IPMI BMC subnet mask",
	.type = &setting_type_ipv4,
	.scope = &ipmi_settings_scope,
};

/** IPMI gateway setting */
static const struct setting ipmi_gateway_setting = {
	.name = "gateway",
	.description = "IPMI BMC gateway",
	.type = &setting_type_ipv4,
	.scope = &ipmi_settings_scope,
};

/** IPMI asset tag setting */
static const struct setting ipmi_tag_setting = {
	.name = "tag",
	.description = "IPMI asset tag",
	.type = &setting_type_string,
	.scope = &ipmi_settings_scope,
};

/**
 * Store IPMI LAN configuration settings
 *
 * @v ip_addr	IP address
 * @v mac_addr	MAC address
 * @v netmask	Subnet mask
 * @v gateway	Default gateway
 * @ret rc	Return status code
 */
int ipmi_store_lan_settings ( struct in_addr ip_addr, uint8_t *mac_addr,
			       struct in_addr netmask, struct in_addr gateway ) {
	int rc;
	
	DBGC ( &ipmi_settings, "IPMI: Storing LAN settings...\n" );
	
	/* Store IP address */
	if ( ( rc = store_setting ( &ipmi_settings, &ipmi_ip_setting,
				     &ip_addr, sizeof ( ip_addr ) ) ) != 0 ) {
		DBGC ( &ipmi_settings, "IPMI: Failed to store IP: %s\n", strerror ( rc ) );
		return rc;
	}
	DBGC ( &ipmi_settings, "IPMI: Stored IP address\n" );
	
	/* Store MAC address */
	if ( ( rc = store_setting ( &ipmi_settings, &ipmi_mac_setting,
				     mac_addr, ETH_ALEN ) ) != 0 ) {
		DBGC ( &ipmi_settings, "IPMI: Failed to store MAC: %s\n", strerror ( rc ) );
		return rc;
	}
	DBGC ( &ipmi_settings, "IPMI: Stored MAC address\n" );
	
	/* Store netmask */
	if ( ( rc = store_setting ( &ipmi_settings, &ipmi_mask_setting,
				     &netmask, sizeof ( netmask ) ) ) != 0 ) {
		DBGC ( &ipmi_settings, "IPMI: Failed to store netmask: %s\n", strerror ( rc ) );
		return rc;
	}
	DBGC ( &ipmi_settings, "IPMI: Stored netmask\n" );
	
	/* Store gateway */
	if ( ( rc = store_setting ( &ipmi_settings, &ipmi_gateway_setting,
				     &gateway, sizeof ( gateway ) ) ) != 0 ) {
		DBGC ( &ipmi_settings, "IPMI: Failed to store gateway: %s\n", strerror ( rc ) );
		return rc;
	}
	DBGC ( &ipmi_settings, "IPMI: Stored gateway\n" );
	
	DBGC ( &ipmi_settings, "IPMI: All LAN settings stored successfully\n" );
	return 0;
}

/**
 * Store IPMI asset tag setting
 *
 * @v tag	Asset tag string
 * @ret rc	Return status code
 */
int ipmi_store_tag_setting ( const char *tag ) {
	int rc;
	DBGC ( &ipmi_settings, "IPMI: Storing asset tag: %s\n", tag );
	rc = store_setting ( &ipmi_settings, &ipmi_tag_setting,
			     tag, strlen ( tag ) );
	if ( rc != 0 ) {
		DBGC ( &ipmi_settings, "IPMI: Failed to store tag: %s\n", strerror ( rc ) );
	} else {
		DBGC ( &ipmi_settings, "IPMI: Asset tag stored successfully\n" );
	}
	return rc;
}

/**
 * Initialise IPMI settings
 */
static void ipmi_settings_init ( void ) {
	int rc;

	/* Register IPMI settings */
	if ( ( rc = register_settings ( &ipmi_settings, NULL,
					 "ipmi" ) ) != 0 ) {
		DBGC ( &ipmi_settings, "IPMI: Could not register settings: %s\n",
		       strerror ( rc ) );
		return;
	}
	DBGC ( &ipmi_settings, "IPMI: Settings registered successfully\n" );
}

/** IPMI settings initialiser */
struct init_fn ipmi_settings_init_fn __init_fn ( INIT_NORMAL ) = {
	.initialise = ipmi_settings_init,
};