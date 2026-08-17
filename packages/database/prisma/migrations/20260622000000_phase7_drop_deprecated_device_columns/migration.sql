/*
  Phase 7 cutover: drop the deprecated dual-written columns from "Device".

  These were kept in lockstep with their canonical homes during the
  MTI/Server cutover and are now read-free:
    - marketplace/capability/provisioning scalars  -> Server
    - hardware-spec cache (cpu/memory/gpu/{nvme,ssd,hdd} columns) -> Cpu / Gpu /
      MemoryConfig / StorageDrive (derived via projectHardwareSummary)
    - networking (primaryIp4/6, ipmiIpAddress, macAddress, mgmtMac) ->
      Interface / IpAddress
    - serialPorts -> DeviceSolConfig

  No indexes/constraints reference these columns. The Device changelog
  trigger is row_to_json-based (column-shape-agnostic), so it is unaffected;
  the Changelog partial indexes on diff->>'isListed' / 'isInterruptible'
  simply stop receiving new matches.
*/

-- AlterTable
ALTER TABLE "Device"
  DROP COLUMN "cpuCoreCount",
  DROP COLUMN "cpuModel",
  DROP COLUMN "cpuPhysicalCount",
  DROP COLUMN "cpuThreadCount",
  DROP COLUMN "ecoMode",
  DROP COLUMN "floorHourlyPrice",
  DROP COLUMN "gpuCount",
  DROP COLUMN "gpuModel",
  DROP COLUMN "hddCount",
  DROP COLUMN "hddSize",
  DROP COLUMN "hourlyPrice",
  DROP COLUMN "ipmiIpAddress",
  DROP COLUMN "ipxeBuildTarget",
  DROP COLUMN "ipxeBuildVersion",
  DROP COLUMN "isInterruptible",
  DROP COLUMN "isListed",
  DROP COLUMN "kernelCmdline",
  DROP COLUMN "macAddress",
  DROP COLUMN "memory",
  DROP COLUMN "mgmtMac",
  DROP COLUMN "nvmeCount",
  DROP COLUMN "nvmeSize",
  DROP COLUMN "primaryIp4",
  DROP COLUMN "primaryIp6",
  DROP COLUMN "purgeTtys",
  DROP COLUMN "serialPorts",
  DROP COLUMN "ssdCount",
  DROP COLUMN "ssdSize",
  DROP COLUMN "storageLayouts",
  DROP COLUMN "teeEnabled",
  DROP COLUMN "vpcCapable";
