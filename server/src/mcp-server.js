import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  createTask,
  deleteTask,
  getProject,
  listTasks,
  listProjects,
  readTask,
  readProjectFile,
  searchFiles,
  toggleTask,
  updateTask,
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
    "list_tasks",
    {
      title: "List tasks",
      description: "List high-level project tasks from tasks/README.md and tasks/*.md.",
      inputSchema: {
        projectId: z.string(),
      },
    },
    async ({ projectId }) => jsonResult(await listTasks(projectId))
  )

  server.registerTool(
    "read_task",
    {
      title: "Read task",
      description: "Read one project task markdown file.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
      },
    },
    async ({ projectId, path }) => jsonResult(await readTask(projectId, path))
  )

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Create a high-level project task under tasks/ and add it to tasks/README.md.",
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
      await createTask(projectId, { title, owner, deadline, body, createdBy })
    )
  )

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description: "Update one project task markdown file and keep tasks/README.md aligned.",
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
      await updateTask(projectId, path, { title, owner, deadline, body, content })
    )
  )

  server.registerTool(
    "toggle_task",
    {
      title: "Toggle task",
      description: "Toggle or set a task checkbox in tasks/README.md only.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
        done: z.boolean().optional(),
      },
    },
    async ({ projectId, path, done }) => jsonResult(await toggleTask(projectId, path, done))
  )

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Delete one project task file and remove its row from tasks/README.md.",
      inputSchema: {
        projectId: z.string(),
        path: z.string(),
      },
    },
    async ({ projectId, path }) => jsonResult(await deleteTask(projectId, path))
  )

  return server
}
