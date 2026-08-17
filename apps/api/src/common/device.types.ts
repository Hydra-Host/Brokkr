import {
  Deployment,
  Device,
  DeviceDiagnostics,
  DeviceTestRun,
  Interface,
  IpAddress,
  Organization,
  Reservation,
  ReservationInvite,
  Server,
  ServersInReservationInvite,
  StorageDrive,
  User,
} from '@repo/database';

export type DeviceDeploymentAggregate = Deployment & {
  deployer?: User;
  customer?: Organization;
  reservation?: Reservation;
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
