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
#include <ipxe/errfile.h>

/** @file
 *
 * IPMI Data Center Manageability Interface (DCMI)
 *
 */



/** DCMI Group Extension Identification */
#define IPMI_DCMI_GROUP_EXT		0xDC

/** DCMI Maximum bytes to read in single request */
#define DCMI_MAX_BYTE_SIZE		16

/**
 * Get DCMI asset tag
 *
 * @v offset	Offset to read from
 * @v length	Number of bytes to read
 * @v rsp	Response structure
 * @ret rc	Return status code
 */
static int get_dcmi_asset_tag(uint8_t offset, uint8_t length, struct ipmi_rs *rsp) {
	struct ipmi_req req;

	memset(&req, 0, sizeof(req));
	req.netfn = IPMI_NETFN_DCGRP;
	req.cmd = IPMI_DCMI_GET_ASSET_TAG;
	req.data_len = 3;
	req.data[0] = IPMI_DCMI_GROUP_EXT;
	req.data[1] = offset;
	req.data[2] = length;

	return ipmi_send_request(&req, rsp);
}

/**
 * Check if response is valid for asset tag
 *
 * @v rsp	IPMI response
 * @ret rc	Return status code
 */
static int check_asset_tag_response(struct ipmi_rs *rsp) {
	/* Accept completion codes 0x80-0x83 as valid for asset tag */
	if (rsp->ccode == IPMI_CC_OK ||
	    (rsp->ccode >= 0x80 && rsp->ccode <= 0x83)) {
		return 0;
	}
	return -EIO;
}

/**
 * IPMI DCMI asset tag command — silently reads the DCMI asset tag
 * and stores it into the iPXE ${ipmi/tag} setting.
 *
 * @v argc	Argument count
 * @v argv	Argument list
 * @ret rc	Return status code
 */
int ipmi_dcmi_asset_tag(int argc __unused, char **argv __unused) {
	struct ipmi_rs rsp;
	char asset_tag[256];
	uint8_t tag_length = 0;
	uint8_t offset = 0;
	uint8_t read_length;
	int rc, i;
	int total_read = 0;

	/* First read to get the total length */
	if ((rc = get_dcmi_asset_tag(0, 0, &rsp)) != 0) {
		return rc;
	}

	if ((rc = check_asset_tag_response(&rsp)) != 0) {
		return rc;
	}

	if (rsp.data_len < 2) {
		return -EIO;
	}

	tag_length = rsp.data[1];
	if (tag_length == 0) {
		return 0;
	}

	memset(asset_tag, 0, sizeof(asset_tag));

	/* Read the asset tag in chunks */
	while (offset < tag_length) {
		/* Calculate how much to read this time */
		read_length = tag_length - offset;
		if (read_length > DCMI_MAX_BYTE_SIZE) {
			read_length = DCMI_MAX_BYTE_SIZE;
		}

		if ((rc = get_dcmi_asset_tag(offset, read_length, &rsp)) != 0) {
			return rc;
		}

		if ((rc = check_asset_tag_response(&rsp)) != 0) {
			return rc;
		}

		if (rsp.data_len < 2) {
			return -EIO;
		}

		for (i = 0; i < read_length && (i + 2) < rsp.data_len; i++) {
			if (total_read < (int)(sizeof(asset_tag) - 1)) {
				asset_tag[total_read] = rsp.data[i + 2];
			}
			total_read++;
		}

		offset += read_length;

		/* Safety check to prevent infinite loop */
		if (total_read >= tag_length) {
			break;
		}
	}

	/* Store the asset tag in iPXE settings */
	if (total_read > 0) {
		asset_tag[total_read] = '\0';
		ipmi_store_tag_setting(asset_tag);
	}

	return 0;
}
