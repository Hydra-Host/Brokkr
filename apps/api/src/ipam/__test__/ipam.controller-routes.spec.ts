import { MODULE_METADATA } from '@nestjs/common/constants';
import { API_PREFIX } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { controllerRoutePaths } from '../../__test__/controller-route-paths';
import { IpamChangelogController } from '../changelog/changelog.controller';
import { GatewayController } from '../gateway/gateway.controller';
import { IpAddressController } from '../ip-address/ip-address.controller';
import { IpRangeController } from '../ip-range/ip-range.controller';
import { IpamRoleController } from '../ipam-role/ipam-role.controller';
import { IpamModule } from '../ipam.module';
import { PrefixController } from '../prefix/prefix.controller';
import { VlanGroupController } from '../vlan-group/vlan-group.controller';
import { VlanController } from '../vlan/vlan.controller';
import { VrfController } from '../vrf/vrf.controller';

describe(`IPAM controllers register routes under the ${API_PREFIX} prefix`, () => {
  const controllers = [
    VrfController,
    PrefixController,
    IpAddressController,
    VlanController,
    VlanGroupController,
    IpRangeController,
    IpamChangelogController,
    IpamRoleController,
    GatewayController,
  ];

  it('covers every controller IpamModule registers', () => {
    const registered: unknown = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, IpamModule);
    expect(registered).toEqual(expect.arrayContaining(controllers));
    expect(controllers).toEqual(expect.arrayContaining(Array.isArray(registered) ? registered : []));
  });

  for (const controller of controllers) {
    it(`${controller.name} routes are all prefixed with ${API_PREFIX}/`, () => {
      const paths = controllerRoutePaths(controller);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((path) => !path.startsWith(`${API_PREFIX}/`))).toEqual([]);
    });
  }
});
