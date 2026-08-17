import { z } from 'zod';

const benchmarkTestSchema = z.object({
  stderr: z.string().nullable(),
  success: z.boolean(),
  gpu_count: z.number(),
  test_name: z.string(),
  total_errors: z.number(),
  min_latency_us: z.number().nullable(),
  peak_busbw_gbs: z.number(),
  out_of_bounds_errors: z.number(),
  avg_bus_bandwidth_gbs: z.number().nullable(),
});

const benchmarkRunDataSchema = z.object({
  data: z
    .object({
      tests: z.array(benchmarkTestSchema),
    })
    .optional(),
  jobId: z.string().optional(),
  job_id: z.string().optional(),
  status: z.string().optional(),
  deviceId: z.string().optional(),
  test_type: z.string().optional(),
  test_passed: z.boolean().optional(),
  tests_total: z.number().optional(),
  tests_passed: z.number().optional(),
});

export const latestDeviceTestRunRowSchema = z
  .object({
    id: z.string().uuid().nullable(),
    deviceMetadataId: z.number().nullable(),
    deviceId: z.string().uuid().nullable(),
    type: z.string().nullable(),
    status: z.string().nullable(),
    deviceStatus: z.string().nullable().optional(),
    // `Device.role` is nullable and write-once — null means the device has not
    // been claimed into a role yet (still commissioning).
    role: z.string().nullable().optional(),
    zoneId: z.string().uuid().nullable(),
    startTime: z.coerce.date().nullable(),
    endTime: z.coerce.date().nullable(),
    durationSeconds: z.number().nullable(),
    testPassed: z.boolean().nullable(),
    data: benchmarkRunDataSchema.nullable(),
    createdAt: z.coerce.date().nullable(),
    updatedAt: z.coerce.date().nullable(),
  })
  .passthrough();

export type LatestDeviceTestRunRow = z.infer<typeof latestDeviceTestRunRowSchema>;
