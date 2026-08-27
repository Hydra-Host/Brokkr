import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import { err, ok, type ToolError, type ToolResult } from '../shared.js';
import { hostStackCandidates } from '../stack-registry.js';
import { describeCheckout, selectStackTarget } from '../target.js';

const DESCRIPTION =
  'Read-only, no gate: choose which host stack slot every other lab_* tool talks to, for the rest of this MCP session. Call it with no argument to list the stacks registered on this host (slot, checkout, liveness, whether it belongs to this repository) — that listing is the only stack read that works before a target exists. Pass slot to target any stack by number, or checkout to name a worktree of THIS repository (substring or exact directory name); a checkout of another clone is reachable by slot number only. Use this when a tool refuses with "this checkout owns no dev-stack slot", which happens when your session runs in a checkout that has not run `task up` while a sibling worktree owns the stack. The choice is in memory only and is lost when the server restarts. While a foreign stack is targeted every tool result carries a [lab: slot N · checkout] marker.';

export function registerStackTargetTools(server: McpServer, ctx: LabContext): void {
  server.tool(
    'lab_use_stack',
    DESCRIPTION,
    {
      slot: z.number().int().min(0).max(46).optional().describe('Host slot number to target'),
      checkout: z
        .string()
        .min(1)
        .optional()
        .describe('Directory name of a checkout of this repository, e.g. a worktree slug'),
    },
    (args): ToolResult | ToolError => {
      try {
        if (args.slot === undefined && args.checkout === undefined) {
          return ok({
            targeted: ctx.targetInfo,
            stacks: hostStackCandidates(ctx.registryDir).map((candidate) => ({
              ...candidate,
              where: describeCheckout(candidate.checkout),
            })),
          });
        }
        const target = selectStackTarget(args, ctx.registryDir);
        ctx.setTarget(target);
        return ok({
          targeted: {
            slot: target.slot,
            checkout: target.checkout,
            where: target.checkout === null ? null : describeCheckout(target.checkout),
            baseUrl: target.baseUrl,
            sameRepo: target.sameRepo,
          },
        });
      } catch (error) {
        return err(error);
      }
    },
  );
}
