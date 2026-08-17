import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import {
  CustomizationsSchema,
  DiskLayoutSelectionSchema,
  DiskLayoutsSchema,
  LayerCatalogSchema,
  PlanCatalogSchema,
  PostTestEventSchema,
  TestEventSchema,
  TestResultSchema,
  TestScenarioSchema,
} from '../schemas/test';

export const testRoutes = {
  listTests: {
    method: 'GET',
    path: '/api/tests',
    responses: { 200: z.array(TestScenarioSchema) },
    summary: 'List runnable test scenarios',
    description:
      'Returns the catalog of scenarios the control center can launch — each backed by a vitest e2e suite, with its picker declarations — used to render the test runner UI.',
  },
  startTest: {
    method: 'POST',
    path: '/api/tests/runs',
    body: z.object({
      scenarioId: z.string(),
      nodeIndex: z.number().int().min(0).nullable().optional(),
      base: z.string().optional().describe('Base OS slug for the layer picker (operatingSystem)'),
      customizations: CustomizationsSchema.optional().describe('Layer picker selections (group → slug(s))'),
      cloudInit: z.string().optional().describe('Composed cloud-init user-data for the cloud-init picker'),
      rescueOs: z
        .string()
        .optional()
        .describe('Rescue OS slug for the rescue picker (admin-only choice; SIM_RESCUE_OS)'),
      baseOses: z
        .array(z.string())
        .optional()
        .describe('Base OS slugs to cycle for the base-os picker (SIM_BASEOS_LIST)'),
      ipxeUrl: z
        .string()
        .optional()
        .describe(
          'Custom iPXE script URL for the ipxe picker (SIM_IPXE_URL) — the trusted full-provision URL or the netboot.xyz menu (chainload-only)',
        ),
      diskLayouts: z
        .array(DiskLayoutSelectionSchema)
        .optional()
        .describe('Disk-layout selections to cycle for the disklayout picker (SIM_DISK_LAYOUTS)'),
      steps: z
        .array(z.string())
        .optional()
        .describe('Selected sub-step values for scenarios that declare a steps list (SIM_LC_STEPS)'),
      plan: z
        .string()
        .optional()
        .describe(
          'Assembled test plan for the plan picker (SIM_PLAN): a preset name or an inline plan JSON of ordered steps',
        ),
    }),
    responses: {
      200: z.object({ runId: z.string() }),
      404: ErrorBodySchema,
      409: ErrorBodySchema.describe('Node already has a running test'),
    },
    summary: 'Run a test scenario',
    description:
      'Launches the scenario as a background vitest run with the chosen picker selections and returns its runId; output streams over SSE and the per-run service log slices are captured on completion. Returns 409 if the target node already has a running test. Loopback-only (it spawns a host process): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getDiskLayouts: {
    method: 'GET',
    path: '/api/tests/disk-layouts/:nodeIndex',
    responses: { 200: DiskLayoutsSchema, 400: ErrorBodySchema },
    summary: "Get a node's disk layouts",
    description:
      'Read-only: returns the node storageLayouts — the discovered disk groups, their capabilities, and the seeded default layout — for one node so the disk-layout picker can offer valid selections. Returns 400 for a bad node index.',
  },
  getLayerCatalog: {
    method: 'GET',
    path: '/api/tests/layers/:nodeIndex',
    responses: { 200: LayerCatalogSchema, 400: ErrorBodySchema },
    summary: "Get a node's OS-layer catalog",
    description:
      'Read-only: returns the hub-computed set of base OSes and customization layers this node is eligible for, used to populate the layer picker. Returns 400 for a bad node index.',
  },
  getPlanCatalog: {
    method: 'GET',
    path: '/api/tests/plan-catalog',
    responses: { 200: PlanCatalogSchema },
    summary: 'Get the custom-plan builder catalog',
    description:
      'Read-only: returns the assemblable step catalog and the ready-made preset plans the custom-plan builder clones and edits, then submits to the plan-custom scenario as an assembled plan.',
  },
  purgeTestRuns: {
    method: 'POST',
    path: '/api/tests/runs/purge',
    body: z.object({ runId: z.string().optional().describe('Purge one run; omit to purge all') }),
    responses: { 200: z.object({ purged: z.number() }) },
    summary: 'Delete test result(s) from disk',
    description:
      'Destructive: removes the on-disk run results (captured log slices + metadata) for one run, or for every run when runId is omitted, and returns how many were purged. Loopback-only (it deletes host run artifacts): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getTestResult: {
    method: 'GET',
    path: '/api/tests/runs/:runId/result',
    pathParams: z.object({ runId: z.string().describe('Run to fetch results for') }),
    responses: {
      200: TestResultSchema,
      404: ErrorBodySchema,
    },
    summary: "Get a run's structured test results",
    description:
      "Read-only: returns the run's parsed result — summary counts and per-case breakdown (tests[] is empty until the structured vitest reporter lands) plus runLogs, the captured per-run service log slices. Returns 404 for an unknown run.",
  },
  postTestEvent: {
    method: 'POST',
    path: '/api/tests/runs/:runId/events',
    pathParams: z.object({ runId: z.string() }),
    body: PostTestEventSchema,
    responses: {
      204: z.undefined(),
      404: ErrorBodySchema,
    },
    summary: 'Record a structured test event',
    description:
      'Callback the running test process uses to append a structured progress event for the run; returns 204 with no body. Returns 404 for an unknown run.',
  },
  listTestEvents: {
    method: 'GET',
    path: '/api/tests/runs/:runId/events',
    pathParams: z.object({ runId: z.string() }),
    responses: {
      200: z.array(TestEventSchema),
      404: ErrorBodySchema,
    },
    summary: 'List all events for a test run',
    description:
      'Read-only: returns the recorded structured events for a run in order so the UI can replay its timeline after the live stream has ended. Returns 404 for an unknown run.',
  },
} as const;
