import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  createPlanItem,
  deletePlanItem,
  getProject,
  listPlanItems,
  listProjects,
  readPlanItem,
  readProjectFile,
  searchFiles,
  togglePlanItem,
  updatePlanItem,
} from "./storage.js"

function jsonResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}

export function createDevsyncMcpServer() {
  const server = new McpServer({
    name: "devsync",
    version: "0.1.0",
  })

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List Devsync projects and their metadata.",
    },
    async () => jsonResult(await listProjects())
  )

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Return metadata and file lists for one project.",
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => jsonResult(await getProject(projectId))
  )

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description: "Search Devsync markdown files by name or content.",
      inputSchema: {
        projectId: z.string().optional(),
        query: z.string().optional(),
      },
    },
    async ({ projectId, query }) => jsonResult(await searchFiles({ projectId, query }))
  )

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 project file by project-relative path.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
      },
    },
    async ({ projectId, path }) => jsonResult(await readProjectFile(projectId, path))
  )

  server.registerTool(
    "list_plan_items",
    {
      title: "List plan items",
      description: "List high-level project plan items from plan/README.md and plan/*.md.",
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => jsonResult(await listPlanItems(projectId))
  )

  server.registerTool(
    "read_plan_item",
    {
      title: "Read plan item",
      description: "Read one project plan item markdown file.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
      },
    },
    async ({ projectId, path }) => jsonResult(await readPlanItem(projectId, path))
  )

  server.registerTool(
    "create_plan_item",
    {
      title: "Create plan item",
      description: "Create a high-level project plan item under plan/ and add it to plan/README.md.",
      inputSchema: {
        projectId: z.string(),
        title: z.string(),
        owner: z.string().optional(),
        deadline: z.string().optional(),
        body: z.string().optional(),
        createdBy: z.string().optional(),
      },
    },
    async ({ projectId, title, owner, deadline, body, createdBy }) => jsonResult(
      await createPlanItem(projectId, { title, owner, deadline, body, createdBy })
    )
  )

  server.registerTool(
    "update_plan_item",
    {
      title: "Update plan item",
      description: "Update one project plan item markdown file and keep plan/README.md aligned.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
        title: z.string().optional(),
        owner: z.string().optional(),
        deadline: z.string().optional(),
        body: z.string().optional(),
        content: z.string().optional(),
      },
    },
    async ({ projectId, path, title, owner, deadline, body, content }) => jsonResult(
      await updatePlanItem(projectId, path, { title, owner, deadline, body, content })
    )
  )

  server.registerTool(
    "toggle_plan_item",
    {
      title: "Toggle plan item",
      description: "Toggle or set a plan item checkbox in plan/README.md only.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
        done: z.boolean().optional(),
      },
    },
    async ({ projectId, path, done }) => jsonResult(await togglePlanItem(projectId, path, done))
  )

  server.registerTool(
    "delete_plan_item",
    {
      title: "Delete plan item",
      description: "Delete one project plan item file and remove its row from plan/README.md.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
      },
    },
    async ({ projectId, path }) => jsonResult(await deletePlanItem(projectId, path))
  )

  return server
}
