import type { Type } from '@nestjs/common';
import type { Composer } from './composer.types';
import { IpmiInterfaceComposer } from './ipmi-interface.composer';
import { LifecycleComposer } from './lifecycle.composer';
import { NetworkIpComposer } from './network-ip.composer';
import { NetworkTypeComposer } from './network-type.composer';
import { StorageLayoutsComposer } from './storage-layouts.composer';
import { TeeComposer } from './tee.composer';

export const COMPOSERS: Type<Composer>[] = [
  LifecycleComposer,
  TeeComposer,
  IpmiInterfaceComposer,
  NetworkIpComposer,
  NetworkTypeComposer,
  StorageLayoutsComposer,
];

export type { Composer } from './composer.types';
export {
  IpmiInterfaceComposer,
  LifecycleComposer,
  NetworkIpComposer,
  NetworkTypeComposer,
  StorageLayoutsComposer,
  TeeComposer,
};
