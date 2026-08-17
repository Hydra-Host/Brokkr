import { z } from 'zod';

export const buildRoutes = {
  buildAgent: {
    method: 'POST',
    path: '/api/build/agent',
    body: z.object({}).optional(),
    responses: { 200: z.object({ runId: z.string() }) },
    summary: 'Rebuild the bridge-agent image',
    description:
      'Repacks brokkr-live + bridge-agent.img from the current agent/src/; run after any edit there so the next provision picks up the new agent. Starts a background run and returns its runId immediately (progress streams over SSE at /api/runs/:runId/stream). The new image is only consumed by the next provision, so an in-flight deployment is unaffected. Loopback-only (it spawns a host build writing the host filesystem): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  buildNetbootGrub: {
    method: 'POST',
    path: '/api/build/netboot-grub',
    body: z.object({}).optional(),
    responses: { 200: z.object({ runId: z.string() }) },
    summary: 'Rebuild the netboot GRUB binaries',
    description:
      'Rebuilds the GRUB binaries the bridge serves at /api/grub (bootx64.efi + bootaa64.efi + core.img); run after edits to boot/grub/*.cfg or the Dockerfile GRUB_*_MODULES. Starts a background run and returns its runId immediately (progress streams over SSE at /api/runs/:runId/stream). Needed whenever the netboot menu or embedded grub modules change so devices chainload the updated binaries. Loopback-only (it spawns a host build writing the host filesystem): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  buildIpxe: {
    method: 'POST',
    path: '/api/build/ipxe',
    body: z.object({}).optional(),
    responses: { 200: z.object({ runId: z.string() }) },
    summary: 'Rebuild the iPXE binaries + ISO',
    description:
      'Rebuilds the iPXE EFI binaries + ISO the bridge serves via TFTP (amd64 + arm64 ipxe.efi/snp.efi/snponly.efi + ipxe.iso); run after edits to boot/ipxe/ overlays, config headers, or the autoexec script. Starts a background run and returns its runId immediately (progress streams over SSE at /api/runs/:runId/stream). Needed whenever the iPXE overlays or autoexec change so TFTP serves the updated boot firmware. Loopback-only (it spawns a host build writing the host filesystem): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
} as const;
