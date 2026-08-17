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

#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <getopt.h>
#include <ipxe/command.h>
#include <ipxe/parseopt.h>
#include <ipxe/ipmi.h>
#include <ipxe/errfile.h>

/** @file
 *
 * IPMI commands
 *
 */


/** "ipmi" options */
struct ipmi_options {};

/** "ipmi" option list */
static struct option_descriptor ipmi_opts[] = {};

/** "ipmi" command descriptor */
static struct command_descriptor ipmi_cmd = 
	COMMAND_DESC ( struct ipmi_options, ipmi_opts, 1, MAX_ARGUMENTS,
		       "lan|tag [<arguments>]" );

/**
 * Print ipmi command usage
 */
static void ipmi_usage(void) {
	printf("Usage:\n");
	printf("  ipmi <command> [arguments]\n");
	printf("\n");
	printf("Available commands:\n");
	printf("  lan [channel]           Show LAN configuration (equivalent to ipmitool lan print)\n");
	printf("  tag                     Show asset tag (equivalent to ipmitool dcmi asset_tag)\n");
	printf("\n");
	printf("Examples:\n");
	printf("  ipmi lan                Show LAN configuration for first available channel\n");
	printf("  ipmi lan 1              Show LAN configuration for channel 1\n");
	printf("  ipmi tag                Show DCMI asset tag\n");
	printf("\n");
}

/**
 * The "ipmi" command
 *
 * @v argc	Argument count
 * @v argv	Argument list
 * @ret rc	Return status code
 */
static int ipmi_exec(int argc, char **argv) {
	struct ipmi_options opts;
	int rc;

	/* Parse options */
	if ((rc = parse_options(argc, argv, &ipmi_cmd, &opts)) != 0)
		return rc;

	/* Initialize IPMI interface */
	if ((rc = ipmi_init()) != 0) {
		printf("Error: No IPMI interface found\n");
		printf("Make sure you are running on hardware with BMC support\n");
		return rc;
	}

	/* Need at least one argument */
	if (optind >= argc) {
		ipmi_usage();
		rc = -EINVAL;
		goto cleanup;
	}

	/* Handle subcommands */
	if (strcmp(argv[optind], "help") == 0) {
		ipmi_usage();
		rc = 0;
	} else if (strcmp(argv[optind], "lan") == 0) {
		/* LAN configuration command */
		rc = ipmi_lan_print(argc - optind, &argv[optind]);
	} else if (strcmp(argv[optind], "tag") == 0) {
		/* Asset tag command */
		rc = ipmi_dcmi_asset_tag(argc - optind, &argv[optind]);
	} else {
		printf("Unknown command: %s\n", argv[optind]);
		printf("Use 'ipmi help' for usage information.\n");
		rc = -EINVAL;
	}

cleanup:
	ipmi_cleanup();
	return rc;
}

/** IPMI command */
COMMAND ( ipmi, ipmi_exec );