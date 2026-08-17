import { Deployment, DeploymentLifecycleAction, Device, Member, Organization, User } from '@repo/database';

export type SupplierWithMembersAndUsers = Organization & {
  members: (Member & {
    user: User;
  })[];
};

export type DeviceWithSupplierAndDeployment = {
  deviceId: string;
  primaryIp4: string | null;
  primaryIp6: string | null;
  device: Device & {
    supplier: SupplierWithMembersAndUsers;
    deployments: (Deployment & {
      lifecycleActions: DeploymentLifecycleAction[];
    })[];
  };
};
