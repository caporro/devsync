import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  addLog, appendTaskComment, createProject, createDocument, updateDocument, readDocument, createTask, deleteTask,
  getProject, listTasks, listProjects, readTask, readProjectFile, readDocFile,
  searchFiles, toggleTask, updateTask, reorderTasks, TASK_STATUSES,
} from "./storage.js"
import { emitAutomationEvent } from "./automation-triggers.js"
import { writeAttribution } from "./attribution.js"
import { listSystemLogEvents } from "./system-log.js"

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

export function createDevsyncMcpServer({ user, baseUrl = process.env.DEVSYNC_PUBLIC_URL ?? "" } = {}) {
  if (baseUrl && !["http:", "https:"].includes(new URL(baseUrl).protocol)) throw new Error("DEVSYNC_PUBLIC_URL must use HTTP or HTTPS")
  const server = new McpServer({ name: "devsync", version: "0.1.28" })
  const projectId = z.string().min(1).describe("Project folder ID returned by list_projects.")
  const filePath = z.string().min(1).describe("Path relative to the project or docs folder, including its area, e.g. resources/analysis.md.")
  const ref = z.string().min(1).describe("Five-character document ID, shared HTTP /d/ID URL, or devsync://document/ID reference.")
  const location = { ref: ref.optional(), projectId: projectId.optional(), docId: z.string().min(1).optional(), path: filePath.optional() }
  function link(value) {
    return value?.url && baseUrl ? { ...value, url: new URL(value.url, baseUrl).href } : value
  }
  function taskLink(task, projectId) {
    return link({ ...task, projectId, url: `/d/${task.id}`, ref: `devsync://document/${task.id}` })
  }
  function register(name, description, inputSchema, handler) {
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try { return jsonResult(await handler(input)) }
      catch (cause) {
        const statusCode = cause.statusCode ?? (["ENOENT", "ENOTDIR"].includes(cause.code) ? 404 : 500)
        return { ...jsonResult({ error: cause.message, statusCode }), isError: true }
      }
    })
  }
  function registerWrite(name, description, inputSchema, handler) {
    register(name, description, {
      ...inputSchema,
      agentName: z.string().nullable().optional().describe("Optional declared agent name for this call (max 100 characters, single line). Empty/omitted uses the authenticated user. The authenticated identity is always retained in audit; this name grants no permissions.")
    }, (input) => handler({ ...input, ...writeAttribution(user, input.agentName, "mcp") }))
  }
  register("list_projects", "List available projects and their metadata. Use a returned project ID to browse or publish project documents.", {}, () => listProjects())
  registerWrite("create_project", "Create a filesystem project using the same operation as REST. The folder ID is derived from name or optional slug; the displayed name follows that folder ID. Existing projects are never overwritten. Returns project metadata and initial files.", {
    name: z.string().trim().min(1), slug: z.string().trim().min(1).optional(),
    owner: z.string().optional(), status: z.string().optional(), tags: z.array(z.string()).optional()
  }, (input) => createProject(input))
  register("list_system_log", "Read the audit trail, newest first. Optional exact actor and authenticatedBy filters combine with AND and are applied before the result limit. Historical entries without authenticatedBy do not match that filter.", {
    actor: z.string().optional(), authenticatedBy: z.string().optional(), action: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional()
  }, (input) => listSystemLogEvents(input))
  register("get_project", "Get one project's metadata and lists of resources, work files, tasks and activity files.", { projectId }, ({ projectId }) => getProject(projectId))
  registerWrite("append_log", "Append a project activity update attributed to agentName or the authenticated user. Long entries are saved as Markdown resources with a link in the log. Emits the same project_log.added automation event as HTTP.", {
    projectId, content: z.string().trim().min(1),
  }, async (input) => {
    const entry = await addLog(input.projectId, input)
    void emitAutomationEvent({ type: "project_log.added", projectId: input.projectId, payload: { entry } })
      .catch((error) => console.error("Activity log automation event failed:", error.message))
    return entry
  })
  register("search_files", "Search all Markdown documents, including shared docs and project READMEs, using BM25 relevance. Every query word must match, regardless of order or case; accents are normalized. Returns excerpts, stable IDs and share links. Optional filters narrow the results.", {
    query: z.string().min(1), projectId: projectId.optional(), docId: z.string().optional(),
    tag: z.string().optional(), author: z.string().optional().describe("Exact creator name: a declared agent name or an authenticated user's identity."),
    type: z.enum(["resources", "work", "tasks", "logs", "readme", "docs"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, async (input) => (await searchFiles(input)).map(link))
  register("read_file", "Read a document using ref (ID, shared URL or devsync://document/ID), or projectId/docId plus path. Markdown results include content, immutable ID, share URL and revision for safe updates. Existing path-based calls remain supported. Only known text formats can be read.", location, async (input) => {
    const indexedMarkdown = /\.md$/i.test(input.path ?? "") && (input.docId || /^(?:README\.md|(?:resources|artifacts|work|generated|tasks|plan|logs)\/)/i.test(input.path ?? ""))
    if (input.ref || indexedMarkdown) return link(await readDocument(input))
    if (!/\.(md|txt|json|ya?ml|csv|log)$/i.test(input.path ?? "")) throw Object.assign(new Error("Only known text files can be read"), { statusCode: 400 })
    if (Boolean(input.projectId) === Boolean(input.docId)) throw Object.assign(new Error("Specify projectId or docId"), { statusCode: 400 })
    return input.projectId ? readProjectFile(input.projectId, input.path) : readDocFile(input.docId, input.path)
  })
  registerWrite("create_document", "Publish a Markdown document in exactly one project (resources or work) or shared docs folder (docId). Creates a stable ID and share link, records agentName or the authenticated user as creator, and logs project publication. Content is Markdown; tags are optional.", {
    projectId: projectId.optional(), docId: z.string().min(1).optional(),
    area: z.enum(["resources", "work"]).optional(), folder: z.string().optional(),
    title: z.string().min(1), content: z.string().min(1), tags: z.array(z.string()).optional(),
  }, async (input) => link(await createDocument(input)))
  registerWrite("update_document", "Update a Markdown document by stable reference or location. First read_file and pass its revision as expectedRevision: stale writes are rejected. Preserves ID and original creator; agentName or the authenticated user becomes last editor. Activity logs remain append-only. Omitted title/tags preserve existing metadata.", {
    ...location, content: z.string(), title: z.string().min(1).optional(), tags: z.array(z.string()).optional(),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  }, async (input) => link(await updateDocument(input)))
  const revision = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("Current task revision from read_task or list_tasks; stale writes are rejected.")
  const status = z.enum(TASK_STATUSES)
  register(
    "list_tasks",
    "List project tasks in manual order with creator, last editor, status, deadline and revision. Compact by default (no content). Filters combine with AND. Pass limit (1–100) for {items, nextCursor}; repeat filters with the cursor. Changed results invalidate the cursor (409). Without limit/cursor returns the compatible array.",
    {
      projectId,
      done: z.boolean().optional(), status: status.optional(), owner: z.string().optional(),
      createdBy: z.string().optional(), tag: z.string().optional().describe("Exact tag; combines with other filters."),
      overdue: z.boolean().optional().describe("Deadline before today (UTC), excluding done/rejected tasks."),
      updatedSince: z.string().optional().describe("ISO timestamp with timezone; filters by filesystem modification time, strictly after it."),
      compact: z.boolean().optional().describe("Defaults to true. Set false to include Markdown content."),
      limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional()
    },
    ({ projectId, ...options }) => listTasks(projectId, options)
  )
  register(
    "read_task",
    "Read a complete Markdown task, its six-state status, manual order, stable ID and revision.",
    { projectId, path: filePath },
    async (input) => {
      const task = await readTask(input.projectId, input.path)
      return taskLink(task, input.projectId)
    }
  )
  registerWrite(
    "append_task_comment",
    "Append a Markdown comment to a task without rewriting its description. Author and date are assigned by the server; optional agentName selects the declared author. No expectedRevision is needed: concurrent appends use the latest task under its write lock. Returns the new comment, task path and revision. Read_task returns all comments and descriptionContent separately.",
    { projectId, path: filePath, content: z.string().trim().min(1) },
    async (input) => {
      const { comment, path, revision } = await appendTaskComment(input.projectId, input.path, input)
      return { comment, path, revision }
    }
  )
  registerWrite(
    "create_task",
    "Create a self-contained Markdown task. Default status is backlog. Creator is agentName or the authenticated user; assigning an owner does not start execution.",
    {
      projectId,
      title: z.string().min(1),
      status: status.optional(),
      owner: z.string().optional(),
      deadline: z.string().optional(),
      tags: z.array(z.string()).optional(),
      body: z.string().optional()
    },
    async (input) => {
      const task = await createTask(input.projectId, input)
      return taskLink(task, input.projectId)
    }
  )
  registerWrite(
    "update_task",
    "Update one task's fields or Markdown using its current revision. Preserves ID and original creator; records audit and automation events.",
    {
      projectId,
      path: filePath,
      title: z.string().optional(),
      status: status.optional(),
      owner: z.string().optional(),
      deadline: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Replaces the tags; an empty array clears them. Omitted preserves existing tags."),
      body: z.string().optional(),
      content: z.string().optional(),
      expectedRevision: revision
    },
    async (input) => taskLink(await updateTask(input.projectId, input.path, input), input.projectId)
  )
  registerWrite(
    "toggle_task",
    "Compatibility operation: mark done or reopen as todo. Prefer update_task with an explicit status.",
    {
      projectId,
      path: filePath,
      done: z.boolean().optional(),
      expectedRevision: revision
    },
    (input) =>
      toggleTask(input.projectId, input.path, input.done, input)
  )
  registerWrite(
    "reorder_tasks",
    "Set the project's complete manual task order. Read list_tasks first and include each task's current revision.",
    {
      projectId,
      items: z.array(z.object({ path: filePath, expectedRevision: revision }))
    },
    (input) => reorderTasks(input.projectId, input)
  )
  registerWrite(
    "delete_task",
    "Permanently delete a task. Use only when the user requests deletion and provide its current revision.",
    {
      projectId,
      path: filePath,
      expectedRevision: revision
    },
    (input) => deleteTask(input.projectId, input.path, input)
  )

  return server
}
