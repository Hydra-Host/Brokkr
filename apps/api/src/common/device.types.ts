import {
  Deployment,
  Device,
  DeviceDiagnostics,
  DeviceTestRun,
  Interface,
  IpAddress,
  Organization,
  ReservationInvite,
  Server,
  ServersInReservationInvite,
  StorageDrive,
  User,
} from '@repo/database';
import { type ReservationWithInvite } from '@repo/device-domain';

export type DeviceDeploymentAggregate = Deployment & {
  deployer?: Pick<User, 'email'> | null;
  customer?: Organization;
  reservation?: ReservationWithInvite;
  deviceDiagnostics?: DeviceDiagnostics[];
};

export type DeviceAggregate = Device & {
  deviceTestRuns?: DeviceTestRun[];
  supplier: Organization;
  interfaces?: (Interface & { ipAddresses: IpAddress[] })[];
  storageDrives: StorageDrive[];
  server:
    | (Server & {
        deployments: DeviceDeploymentAggregate[];
        serversInReservationInvite: (ServersInReservationInvite & {
          reservationInvite: ReservationInvite & {
            inviteeOrganization: Organization;
          };
        })[];
      })
    | null;
};
