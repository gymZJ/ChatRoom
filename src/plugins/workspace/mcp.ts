import { z } from "zod";
import type { PluginMcpRegistrar } from "#mcp/server/plugin-mcp-registrar";
import { closedRead } from "#mcp/server/tool-support";
import type { WorkspaceService } from "./workspace-service.js";

const workspaceEntrySchema = z.object({
  root: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
});

const workspaceListSchema = z.object({
  workspaces: z.array(workspaceEntrySchema),
});

const workspaceInfoSchema = z.object({
  root: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  presetPrompt: z.string().nullable(),
  instructions: z.string().nullable(),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      path: z.string(),
    }),
  ),
});

export function registerWorkspaceTools(
  mcp: PluginMcpRegistrar,
  workspaces: WorkspaceService,
): void {
  mcp.registerTool(
    "workspace_list",
    {
      title: "List workspaces",
      description:
        "List available projects with their workspace roots, names, and project summaries from the workspace prompt metadata. Use this first to identify the relevant project before calling workspace_info for its full prompt, instructions, and skills.",
      inputSchema: z.object({}),
      outputSchema: workspaceListSchema,
      annotations: closedRead,
      action: "list",
    },
    async () => ({ workspaces: await workspaces.list() }),
  );

  mcp.registerTool(
    "workspace_info",
    {
      title: "Workspace info",
      description:
        "Read the complete workspace context for a project, including its summary, preset prompt, project instructions, and skill metadata.",
      inputSchema: z.object({ root: z.string() }),
      outputSchema: workspaceInfoSchema,
      annotations: closedRead,
      action: "info",
    },
    (input) => workspaces.info(input.root),
  );
}
