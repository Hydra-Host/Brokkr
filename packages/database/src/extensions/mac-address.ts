import { canonicalMac, isRecord } from '@repo/utils';
import { Prisma } from '../../generated/js/client.js';

export const formatMacAddress = (mac: string): string => canonicalMac(mac) ?? mac;

export function normalizeMacField(data: unknown): void {
  if (!isRecord(data)) return;
  const value = data.macAddress;
  if (typeof value === 'string') {
    data.macAddress = formatMacAddress(value);
  } else if (isRecord(value) && typeof value.set === 'string') {
    value.set = formatMacAddress(value.set);
  }
}

export const macAddressExtension = Prisma.defineExtension({
  name: 'formatInterfaceMacAddress',
  query: {
    interface: {
      create({ args, query }) {
        normalizeMacField(args.data);
        return query(args);
      },
      update({ args, query }) {
        normalizeMacField(args.data);
        return query(args);
      },
      updateMany({ args, query }) {
        normalizeMacField(args.data);
        return query(args);
      },
      upsert({ args, query }) {
        normalizeMacField(args.create);
        normalizeMacField(args.update);
        return query(args);
      },
      createMany({ args, query }) {
        (Array.isArray(args.data) ? args.data : [args.data]).forEach(normalizeMacField);
        return query(args);
      },
    },
  },
});
