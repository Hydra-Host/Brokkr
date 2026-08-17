import { z } from 'zod';

export const InterfaceConnectionSchema = z.object({
  interfaceA: z
    .object({
      id: z.string().uuid().describe('Interface A UUID'),
      name: z.string().describe('Interface A name'),
      deviceId: z.string().uuid().describe('Device UUID for interface A'),
    })
    .describe('A-side interface'),
  interfaceB: z
    .object({
      id: z.string().uuid().describe('Interface B UUID'),
      name: z.string().describe('Interface B name'),
      deviceId: z.string().uuid().describe('Device UUID for interface B'),
    })
    .describe('B-side interface'),
  cableId: z.string().uuid().describe('Connecting cable UUID'),
});
export type InterfaceConnection = z.infer<typeof InterfaceConnectionSchema>;

export const ConsoleConnectionSchema = z.object({
  consolePort: z
    .object({
      id: z.string().uuid().describe('Console port UUID'),
      name: z.string().describe('Console port name'),
      deviceId: z.string().uuid().describe('Device UUID'),
    })
    .describe('Console port side'),
  consoleServerPort: z
    .object({
      id: z.string().uuid().describe('Console server port UUID'),
      name: z.string().describe('Console server port name'),
      deviceId: z.string().uuid().describe('Device UUID'),
    })
    .describe('Console server port side'),
  cableId: z.string().uuid().describe('Connecting cable UUID'),
});
export type ConsoleConnection = z.infer<typeof ConsoleConnectionSchema>;

export const PowerConnectionSchema = z.object({
  powerPort: z
    .object({
      id: z.string().uuid().describe('Power port UUID'),
      name: z.string().describe('Power port name'),
      deviceId: z.string().uuid().describe('Device UUID'),
    })
    .describe('Power port side'),
  powerOutlet: z
    .object({
      id: z.string().uuid().describe('Power outlet UUID'),
      name: z.string().describe('Power outlet name'),
      deviceId: z.string().uuid().describe('Device UUID'),
    })
    .describe('Power outlet side'),
  cableId: z.string().uuid().describe('Connecting cable UUID'),
});
export type PowerConnection = z.infer<typeof PowerConnectionSchema>;

export const ConnectionsQuerySchema = z.object({
  deviceId: z.string().uuid().optional().describe('Filter by device UUID'),
  zoneId: z.string().uuid().optional().describe('Filter by zone UUID'),
});
export type ConnectionsQuery = z.infer<typeof ConnectionsQuerySchema>;
